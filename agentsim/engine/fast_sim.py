"""
High-Speed Vectorized Wildfire Simulation Engine.
Implements Rothermel-style cellular automata, agent queue dynamics,
and dynamic exit routing for RL environments.
"""

import math
import heapq
import numpy as np
from typing import Dict, List, Set, Any, Optional

from agentsim.engine.loader import World, DIRS, CELL, DT, BS

# Agent status constants
ST_UNAWARE = 0
ST_PREPARING = 1
ST_WAITING = 2
ST_ONROAD = 3
ST_SAFE = 4
ST_ATRISK = 5
ST_TRAPPED = 6

CAP = {'hwy': 3.0, 'art': 1.9, 'urban': 2.0, 'local': 1.5}
FIRE_PBASE = 0.012
FIRE_SPOT = 0.0003
FIRE_SPOT_DIST = 0.5


class SimRun:
    def __init__(self, world: World, params: Optional[Dict[str, Any]] = None):
        self.world = world
        self.p = params or {}
        self.rng = np.random.RandomState(self.p.get('seed', 42))
        
        self.W = world.W
        self.H = world.H
        self.BW = world.BW
        self.BH = world.BH
        self.nh = len(world.homes)
        self.ne = len(world.edges)
        self.nn = len(world.nodes)
        
        # 1. Fire state grids
        self.fire = np.zeros((self.H, self.W), dtype=np.uint8) # 0=unburnt, 1=burning, 2=burnt
        self.burn_left = np.zeros((self.H, self.W), dtype=np.int16)
        self.fire_dist = np.full((self.BH, self.BW), 999, dtype=np.int16)
        self.block_fire = np.zeros((self.BH, self.BW), dtype=np.uint8)
        self.burning_cells: List[int] = []
        
        # 2. Wind configuration
        self.wind_angle = math.radians(self.p.get('wind_deg', 0)) # 0 = North wind blowing South
        self.wind_speed = float(self.p.get('wind_kmh', 50.0))
        self.wx = math.cos(self.wind_angle)
        self.wy = math.sin(self.wind_angle)
        self.wf = np.zeros(8, dtype=np.float32)
        for k in range(8):
            dx, dy = DIRS[k]
            ang = math.atan2(dy, dx)
            cos_a = math.cos(ang - self.wind_angle)
            self.wf[k] = math.exp(math.pow(self.wind_speed / 30.0, 1.6) * cos_a)

        # 3. Agent state arrays
        self.st = np.zeros(self.nh, dtype=np.uint8) # Default ST_UNAWARE
        self.depart_at = np.full(self.nh, -1, dtype=np.int32)
        self.depart_t = np.full(self.nh, -1, dtype=np.int32)
        self.safe_t = np.full(self.nh, -1, dtype=np.int32)
        self.exit_t = np.full(self.nh, -1, dtype=np.int32)
        self.gets_alert = (self.rng.rand(self.nh) < (0.65 if self.p.get('night', False) else 0.88)).astype(np.uint8)
        
        # 4. Traffic & Road Link States
        self.ecap = np.zeros(self.ne, dtype=np.float32)
        self.estore = np.zeros(self.ne, dtype=np.float32)
        self.ebud = np.zeros(self.ne, dtype=np.float32)
        self.eburn = np.zeros(self.ne, dtype=np.int16)
        self.eq: List[List[int]] = [[] for _ in range(self.ne)]
        self.active_edges: Set[int] = set()
        
        contraflow = self.p.get('contraflow', False)
        for e in world.edges:
            lanes = e['lanes']
            if contraflow and e['type'] in ('hwy', 'art'):
                lanes = min(4, lanes * 2)
            self.ecap[e['id']] = CAP.get(e['type'], 1.5) * lanes
            self.estore[e['id']] = max(2.0, lanes * e['len'] / 12.75)

        self.node_wait: List[List[int]] = [[] for _ in range(self.nn)]
        self.wait_nodes: Set[int] = set()
        self.next_node = np.full(self.nn, -1, dtype=np.int32)
        self.closed_dirty = True
        
        # 5. Zone evacuation orders
        nz = len(world.zones)
        self.zone_ordered = np.zeros(nz, dtype=np.uint8)
        self.zone_order_time = np.full(nz, -1, dtype=np.int32)
        
        # 6. Global clock
        self.t = 0
        self.done = False

        # Ignite initial fire
        ign_c = self.p.get('ign_cell')
        if ign_c is None:
            if world.ign_candidates:
                ign_c = self.rng.choice(world.ign_candidates)
            else:
                ign_c = (self.H // 4) * self.W + (self.W // 2)
        self.ignite(ign_c)
        self.recompute_routes()

    def burn_duration(self, lu: int) -> int:
        if lu == 4: return 24  # Chaparral
        if lu == 3: return 40  # WUI
        if lu == 2: return 90  # Urban
        return 6

    def ignite(self, c: int):
        y = c // self.W
        x = c % self.W
        if self.fire[y, x] != 0 or self.world.fuel[y, x] <= 0:
            return
        
        self.fire[y, x] = 1
        self.burn_left[y, x] = self.burn_duration(int(self.world.lu[y, x]))
        self.burning_cells.append(c)
        
        bx, by = x // BS, y // BS
        if not self.block_fire[by, bx]:
            self.block_fire[by, bx] = 1
            self.update_fire_dist()

        # Burn road edges intersecting this cell
        if c in self.world.cell_edges:
            for eid in self.world.cell_edges[c]:
                self.eburn[eid] += 1
                if self.eburn[eid] == 1:
                    self.closed_dirty = True
                    # Trapped vehicles currently on this road
                    for a in self.eq[eid]:
                        self.st[a] = ST_TRAPPED
                    self.eq[eid] = []

        # Homes at immediate risk
        if c in self.world.cell_homes:
            for h in self.world.cell_homes[c]:
                if self.st[h] in (ST_UNAWARE, ST_PREPARING, ST_WAITING):
                    self.st[h] = ST_ATRISK

    def update_fire_dist(self):
        self.fire_dist.fill(999)
        q = []
        for by in range(self.BH):
            for bx in range(self.BW):
                if self.block_fire[by, bx]:
                    self.fire_dist[by, bx] = 0
                    q.append((bx, by))

        idx = 0
        while idx < len(q):
            bx, by = q[idx]
            d = self.fire_dist[by, bx]
            idx += 1
            for dx, dy in DIRS:
                nbx, nby = bx + dx, by + dy
                if 0 <= nbx < self.BW and 0 <= nby < self.BH:
                    if self.fire_dist[nby, nbx] > d + 1:
                        self.fire_dist[nby, nbx] = d + 1
                        q.append((nbx, nby))

    def recompute_routes(self):
        """Dynamic Dijkstra shortest path to exits avoiding closed/burning roads."""
        dist = np.full(self.nn, float('inf'))
        self.next_node.fill(-1)
        pq = []
        
        for n in self.world.nodes:
            if n['exit']:
                dist[n['id']] = 0.0
                heapq.heappush(pq, (0.0, n['id']))

        while pq:
            d, v = heapq.heappop(pq)
            if d > dist[v]:
                continue
            for eid in self.world.nodes[v]['inn']:
                if self.eburn[eid] > 0:
                    continue
                e = self.world.edges[eid]
                u = e['from']
                nd = d + e['len'] / e['speed']
                if nd < dist[u]:
                    dist[u] = nd
                    self.next_node[u] = eid
                    heapq.heappush(pq, (nd, u))

        self.closed_dirty = False

    def step_fire(self):
        new_ign = []
        still_burning = []
        p_base = FIRE_PBASE
        spot_base = FIRE_SPOT * math.pow(self.wind_speed / 10.0, 2)
        
        for c in self.burning_cells:
            y = c // self.W
            x = c % self.W
            fuel_c = self.world.fuel[y, x]
            
            # Spread to 8 neighbors
            for k in range(8):
                nx = x + DIRS[k][0]
                ny = y + DIRS[k][1]
                if 0 <= nx < self.W and 0 <= ny < self.H:
                    if self.fire[ny, nx] == 0 and self.world.fuel[ny, nx] > 0:
                        prob = p_base * self.world.fuel[ny, nx] * self.world.sf[y, x, k] * self.wf[k]
                        if self.rng.rand() < prob:
                            new_ign.append(ny * self.W + nx)

            # Downwind spot fires
            if self.rng.rand() < spot_base * fuel_c:
                ang = self.wind_angle + (self.rng.rand() - 0.5) * 0.6
                d = 3 + self.rng.rand() * self.wind_speed * FIRE_SPOT_DIST
                sx = int(round(x + math.cos(ang) * d))
                sy = int(round(y + math.sin(ang) * d))
                if 0 <= sx < self.W and 0 <= sy < self.H:
                    if self.rng.rand() < self.world.fuel[sy, sx] * 0.6:
                        new_ign.append(sy * self.W + sx)

            self.burn_left[y, x] -= 1
            if self.burn_left[y, x] <= 0:
                self.fire[y, x] = 2 # Burnt out
            else:
                still_burning.append(c)

        self.burning_cells = still_burning
        for n in new_ign:
            self.ignite(n)

    def order_zone(self, zone_idx: int):
        """Issues mandatory evacuation order to a zone."""
        if 0 <= zone_idx < len(self.world.zones) and not self.zone_ordered[zone_idx]:
            self.zone_ordered[zone_idx] = 1
            self.zone_order_time[zone_idx] = self.t
            for h in self.world.homes:
                if h['zone'] == zone_idx and self.gets_alert[h['id']]:
                    if self.st[h['id']] == ST_UNAWARE:
                        self.st[h['id']] = ST_PREPARING
                        delay_min = self.rng.lognormal(mean=2.6, sigma=0.4) # ~14 min median
                        self.depart_at[h['id']] = self.t + max(2, int(round(delay_min * 60 / DT)))

    def step(self):
        """Advances simulation by 1 tick (10 seconds)."""
        if self.done:
            return
        self.t += 1
        self.step_fire()

        # Check fire proximity to unaware households (flames seen from window)
        for h in self.world.homes:
            hid = h['id']
            if self.st[hid] == ST_UNAWARE:
                fd = self.fire_dist[h['b'] // self.BW, h['b'] % self.BW]
                if fd <= 1 and self.rng.rand() < 0.2:
                    self.st[hid] = ST_PREPARING
                    self.depart_at[hid] = self.t + int(round(self.rng.uniform(2, 5) * 60 / DT))

        # Preparing -> Waiting to enter road
        for h in self.world.homes:
            hid = h['id']
            if self.st[hid] == ST_PREPARING and self.t >= self.depart_at[hid]:
                self.st[hid] = ST_WAITING
                self.depart_t[hid] = self.t
                self.node_wait[h['node']].append(hid)
                self.wait_nodes.add(h['node'])

        if self.closed_dirty:
            self.recompute_routes()

        # Node entries (entering road links)
        for n in list(self.wait_nodes):
            wq = self.node_wait[n]
            entries = 0
            while wq and entries < 2:
                a = wq[0]
                if self.st[a] != ST_WAITING:
                    wq.pop(0)
                    continue
                ne = self.next_node[n]
                if ne < 0:
                    break
                if self.eburn[ne] > 0 or len(self.eq[ne]) >= self.estore[ne]:
                    break
                wq.pop(0)
                self.eq[ne].append(a)
                self.active_edges.add(ne)
                self.exit_t[a] = self.t + self.world.edges[ne]['tt']
                self.st[a] = ST_ONROAD
                entries += 1
            if not wq:
                self.wait_nodes.remove(n)

        # Move vehicles along links and discharge to exits
        for eid in list(self.active_edges):
            e = self.world.edges[eid]
            q = self.eq[eid]
            if not q:
                self.ebud[eid] = 0.0
                self.active_edges.remove(eid)
                continue
            
            self.ebud[eid] = min(self.ebud[eid] + self.ecap[eid], max(1.0, self.ecap[eid]))
            to_node = self.world.nodes[e['to']]
            
            while q and self.exit_t[q[0]] <= self.t and self.ebud[eid] >= 1.0:
                a = q[0]
                if to_node['exit']:
                    q.pop(0)
                    self.st[a] = ST_SAFE
                    self.safe_t[a] = self.t
                    self.ebud[eid] -= 1.0
                    continue
                
                ne = self.next_node[e['to']]
                if ne < 0 or self.eburn[ne] > 0 or len(self.eq[ne]) >= self.estore[ne]:
                    break
                
                q.pop(0)
                self.eq[ne].append(a)
                self.active_edges.add(ne)
                self.exit_t[a] = self.t + self.world.edges[ne]['tt']
                self.ebud[eid] -= 1.0

        # Terminate when no active fires or all households settled
        if len(self.burning_cells) == 0 or self.t >= 720: # 2 hours max
            self.done = True

    def get_zone_fire_distance(self, z_idx: int) -> float:
        """Returns distance (km) from active fire perimeter to zone boundary."""
        min_d = 999
        for b in self.world.zone_blocks[z_idx]:
            bx = b % self.BW
            by = b // self.BW
            min_d = min(min_d, int(self.fire_dist[by, bx]))
        return min_d * BS * CELL / 1000.0
