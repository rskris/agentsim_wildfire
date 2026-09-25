"""
Gymnasium Reinforcement Learning Environment for Wildfire Evacuation Management.
"""

from typing import Dict, Any, Tuple, Optional
import numpy as np
import gymnasium as gym
from gymnasium import spaces

from agentsim.engine.loader import World, build_synthetic_world, load_overture_world, DT
from agentsim.engine.fast_sim import SimRun, ST_SAFE, ST_ATRISK, ST_TRAPPED, ST_ONROAD


class WildfireEvacEnv(gym.Env):
    """
    Wildfire Evacuation Environment conforming to Farama Foundation's Gymnasium API.
    
    The RL agent acts as the Incident Commander in the Emergency Operations Center:
    - Observes fire spread, zone proximities, traffic queues, and population evacuation states.
    - Decides which zones to order to evacuate and whether to trigger contraflow lane reversals.
    """
    metadata = {"render_modes": ["human", "ansi"]}

    def __init__(self, world: Optional[World] = None, decision_interval_ticks: int = 30, render_mode: Optional[str] = None):
        super().__init__()
        self.world = world or build_synthetic_world()
        self.decision_interval = decision_interval_ticks # 30 ticks = 5 minutes
        self.render_mode = render_mode
        self.sim: Optional[SimRun] = None
        
        self.nz = len(self.world.zones)
        # Action space: [order_zone_0, ..., order_zone_{N-1}, enable_contraflow]
        self.action_space = spaces.MultiBinary(self.nz + 1)
        
        # Observation: [zone_dist, zone_ordered, pct_safe, pct_fail, pct_onroad] for each zone + 5 global metrics
        self.obs_dim = self.nz * 5 + 5
        self.observation_space = spaces.Box(low=0.0, high=1.0, shape=(self.obs_dim,), dtype=np.float32)
        
        self.prev_safe = 0
        self.prev_fail = 0

    def _get_obs(self) -> np.ndarray:
        obs = np.zeros(self.obs_dim, dtype=np.float32)
        idx = 0
        
        total_homes = max(1, len(self.world.homes))
        # Zone features
        for zi in range(self.nz):
            d_km = self.sim.get_zone_fire_distance(zi)
            obs[idx] = min(1.0, d_km / 10.0) # Normalized distance [0, 10 km]
            obs[idx + 1] = float(self.sim.zone_ordered[zi])
            
            # Zone population counts
            z_homes = [h['id'] for h in self.world.homes if h['zone'] == zi]
            nz_pop = max(1, len(z_homes))
            safe = sum(1 for h in z_homes if self.sim.st[h] == ST_SAFE)
            fail = sum(1 for h in z_homes if self.sim.st[h] in (ST_ATRISK, ST_TRAPPED))
            onroad = sum(1 for h in z_homes if self.sim.st[h] == ST_ONROAD)
            
            obs[idx + 2] = safe / nz_pop
            obs[idx + 3] = fail / nz_pop
            obs[idx + 4] = onroad / nz_pop
            idx += 5
            
        # Global features
        obs[idx] = self.sim.wind_speed / 80.0
        obs[idx + 1] = (self.sim.wind_angle + np.pi) / (2 * np.pi)
        obs[idx + 2] = min(1.0, self.sim.t / 720.0)
        obs[idx + 3] = min(1.0, len(self.sim.burning_cells) / 200.0)
        
        # Max queue congestion
        max_q = 0.0
        for eid in self.sim.active_edges:
            cap = max(1.0, self.sim.ecap[eid])
            max_q = max(max_q, len(self.sim.eq[eid]) / cap)
        obs[idx + 4] = min(1.0, max_q / 5.0)
        
        return obs

    def reset(self, seed: Optional[int] = None, options: Optional[Dict[str, Any]] = None) -> Tuple[np.ndarray, Dict[str, Any]]:
        super().reset(seed=seed)
        run_seed = seed if seed is not None else np.random.randint(0, 1_000_000)
        
        wind_kmh = float(np.random.uniform(30.0, 70.0))
        wind_deg = float(np.random.choice([0, 45, 225])) # Sundowner, Santa Ana, Onshore
        
        params = {
            'seed': run_seed,
            'wind_kmh': wind_kmh,
            'wind_deg': wind_deg,
            'contraflow': False
        }
        self.sim = SimRun(self.world, params)
        self.prev_safe = 0
        self.prev_fail = 0
        
        obs = self._get_obs()
        info = {
            "initial_ign_cell": self.sim.burning_cells[0] if self.sim.burning_cells else 0,
            "wind_kmh": wind_kmh,
            "wind_deg": wind_deg
        }
        return obs, info

    def step(self, action: np.ndarray) -> Tuple[np.ndarray, float, bool, bool, Dict[str, Any]]:
        """
        Executes action for one decision epoch (e.g. 5 simulated minutes = 30 ticks).
        """
        # 1. Apply zone evacuation orders
        for zi in range(self.nz):
            if action[zi] and not self.sim.zone_ordered[zi]:
                self.sim.order_zone(zi)
                
        # 2. Apply contraflow toggle
        if action[self.nz]:
            for e in self.world.edges:
                if e['type'] in ('hwy', 'art'):
                    self.sim.ecap[e['id']] = min(8.0, e['lanes'] * 2 * 3.0)

        # 3. Step simulation forward for the decision interval
        queue_delay = 0.0
        for _ in range(self.decision_interval):
            if self.sim.done:
                break
            self.sim.step()
            for eid in self.sim.active_edges:
                queue_delay += len(self.sim.eq[eid])

        # 4. Compute reward
        curr_safe = int(np.sum(self.sim.st == ST_SAFE))
        curr_fail = int(np.sum((self.sim.st == ST_ATRISK) | (self.sim.st == ST_TRAPPED)))
        
        delta_safe = curr_safe - self.prev_safe
        delta_fail = curr_fail - self.prev_fail
        self.prev_safe = curr_safe
        self.prev_fail = curr_fail
        
        # Reward shaping
        reward = (delta_safe * 10.0) - (delta_fail * 500.0) - (queue_delay * 0.01)
        
        # False alarm penalty: ordering distant zones when fire is far away
        for zi in range(self.nz):
            if action[zi]:
                d = self.sim.get_zone_fire_distance(zi)
                if d > 4.0:
                    reward -= 2.0

        terminated = self.sim.done or self.sim.t >= 720
        truncated = False
        
        obs = self._get_obs()
        info = {
            "time_min": round(self.sim.t * DT / 60.0, 1),
            "total_safe": curr_safe,
            "total_fail": curr_fail,
            "burning_cells": len(self.sim.burning_cells)
        }
        
        return obs, reward, terminated, truncated, info

    def render(self):
        if self.render_mode == "ansi" or self.render_mode == "human":
            safe = int(np.sum(self.sim.st == ST_SAFE))
            fail = int(np.sum((self.sim.st == ST_ATRISK) | (self.sim.st == ST_TRAPPED)))
            onroad = int(np.sum(self.sim.st == ST_ONROAD))
            prep = int(np.sum(self.sim.st == ST_PREPARING))
            print(f"[T+{round(self.sim.t * DT / 60.0)}m] Safe: {safe} | Road: {onroad} | Prep: {prep} | Lost: {fail} | Fires: {len(self.sim.burning_cells)}")
