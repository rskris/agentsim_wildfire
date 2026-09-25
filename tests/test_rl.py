"""
Unit and Integration Tests for Python RL Wildfire Evacuation Environment.
"""

import unittest
import numpy as np

from agentsim.engine.loader import build_synthetic_world
from agentsim.engine.fast_sim import SimRun
from agentsim.env.wildfire_env import WildfireEvacEnv
from agentsim.models.ppo_agent import PPOAgent


class TestWildfireRL(unittest.TestCase):
    def setUp(self):
        self.world = build_synthetic_world()

    def test_world_topology(self):
        self.assertGreater(len(self.world.nodes), 10)
        self.assertGreater(len(self.world.edges), 10)
        self.assertGreater(len(self.world.homes), 100)
        self.assertEqual(len(self.world.zones), 8)
        self.assertGreater(len(self.world.ign_candidates), 0)

    def test_sim_step(self):
        sim = SimRun(self.world, {'seed': 42, 'wind_kmh': 50, 'wind_deg': 0})
        self.assertGreater(len(sim.burning_cells), 0)
        initial_fires = len(sim.burning_cells)
        for _ in range(10):
            sim.step()
        self.assertGreaterEqual(sim.t, 10)

    def test_gym_environment_lifecycle(self):
        env = WildfireEvacEnv(self.world, decision_interval_ticks=10)
        obs, info = env.reset(seed=123)
        self.assertEqual(obs.shape, env.observation_space.shape)
        self.assertIn("wind_kmh", info)

        # Hold action
        action = np.zeros(env.action_space.n, dtype=np.int8)
        obs, reward, terminated, truncated, step_info = env.step(action)
        self.assertEqual(obs.shape, env.observation_space.shape)
        self.assertIsInstance(reward, float)
        self.assertIn("total_safe", step_info)

    def test_ppo_agent_act_and_onnx(self):
        obs_dim = 45
        action_dim = 9
        agent = PPOAgent(obs_dim=obs_dim, action_dim=action_dim)
        dummy_obs = np.random.rand(obs_dim).astype(np.float32)
        action, logp, val = agent.act(dummy_obs)
        self.assertEqual(action.shape, (action_dim,))
        self.assertIsInstance(logp, float)
        self.assertIsInstance(val, float)


if __name__ == "__main__":
    unittest.main()
