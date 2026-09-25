"""
World Loader and Graph Builder for Overture GeoJSON and Synthetic Environments.
"""

import json
import math
import os
from typing import Dict, List, Tuple, Any, Optional
import numpy as np

# Road classifications and speeds
CLS = {
    'motorway': 'hwy', 'motorway_link': 'hwy', 'trunk': 'hwy', 'trunk_link': 'hwy',
    'primary': 'art', 'primary_link': 'art', 'secondary': 'art', 'secondary_link': 'art',
    'tertiary': 'urban', 'tertiary_link': 'urban', 'unclassified': 'local',
    'residential': 'local', 'living_street': 'local'
}

MPH = {
    'motorway': 65, 'motorway_link': 35, 'trunk': 55, 'trunk_link': 35,
    'primary': 40, 'primary_link': 30, 'secondary': 35, 'secondary_link': 30,
    'tertiary': 30, 'tertiary_link': 25, 'unclassified': 25, 'residential': 25, 'living_street': 15
}

RANK = {'hwy': 3, 'art': 2, 'urban': 1, 'local': 0}
DIRS = [[1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1]]
CELL = 50.0
DT = 10.0
BS = 4

class Grid:
    def __init__(self, bbox: Dict[str, float], cell: float = CELL, bs: int = BS):
        self.bbox = bbox
        self.cell = cell
        self.bs = bs
        lat0 = (bbox['s'] + bbox['n']) / 2.0
        self.dLon = cell / (111320.0 * math.cos(math.radians(lat0)))
        self.dLat = cell / 110540.0
        self.W = int(math.ceil((bbox['e'] - bbox['w']) / self.dLon / bs) * bs)
        self.H = int(math.ceil((bbox['n'] - bbox['s']) / self.dLat / bs) * bs)
        self.BW = self.W // bs
        self.BH = self.H // bs

    def to_grid(self, lat: float, lon: float) -> Tuple[float, float]:
        gx = (lon - self.bbox['w']) / self.dLon
        gy = (self.bbox['n'] - lat) / self.dLat
        return gx, gy

    def to_latlng(self, gx: float, gy: float) -> Tuple[float, float]:
        lat = self.bbox['n'] - gy * self.dLat
        lon = self.bbox['w'] + gx * self.dLon
        return lat, lon


class World:
    """Holds the complete simulation topology, fuels, nodes, edges, and agents."""
    def __init__(self, W: int, H: int, grid: Optional[Grid] = None):
        self.W = W
        self.H = H
        self.CELL = CELL
        self.DT = DT
        self.BS = BS
        self.BW = W // BS
        self.BH = H // BS
        self.grid = grid
        
        self.elev = np.zeros((H, W), dtype=np.float32)
        self.fuel = np.zeros((H, W), dtype=np.float32)
        self.lu = np.zeros((H, W), dtype=np.uint8)
        self.road = np.zeros((H, W), dtype=np.uint8)
        self.sf = np.ones((H, W, 8), dtype=np.float32)
        
        self.nodes: List[Dict[str, Any]] = []
        self.edges: List[Dict[str, Any]] = []
        self.homes: List[Dict[str, Any]] = []
        self.zones: List[Dict[str, Any]] = []
        
        self.cell_edges: Dict[int, List[int]] = {}
        self.cell_homes: Dict[int, List[int]] = {}
        self.zone_blocks: List[set] = []
        self.ign_candidates: List[int] = []
        self.dist_exit: np.ndarray = np.array([])
        self.agent_weight: float = 1.0


def build_synthetic_world(W: int = 160, H: int = 100) -> World:
    """
    Builds a synthetic coastal foothill micro-town (Santa Barbara style)
    matching the exact reference topology of src/sim.js.
    """
    world = World(W, H)
    rng = np.random.RandomState(7)
    
    # 1. Elevation and fuels
    for y in range(H):
        for x in range(W):
            cy = 90 + 3 * math.sin(x / 17.0) + 1.5 * math.sin(x / 7.0 + 1.0)
            d = cy - y
            e = d * 5 + max(0, 50 - y) * 14 if d > 0 else 0
            e += (math.sin(x / 6.5) * 0.5 + math.sin(x / 3.1 + y / 5.0) * 0.3) * max(0, 70 - y) * 1.2
            
            # Canyons
            canyon = 0.0
            for ax in [22, 52, 86, 116, 146, 35, 70, 100, 132]:
                canyon = max(canyon, math.exp(-(((x - ax) / 2.5) ** 2)))
            e -= canyon * max(0, 62 - y) * 1.5
            world.elev[y, x] = max(0, e)
            
            # Landuse & fuels
            if y > cy:
                world.lu[y, x] = 0 # Ocean
                world.fuel[y, x] = 0.0
            elif y > cy - 1.5:
                world.lu[y, x] = 1 # Beach
                world.fuel[y, x] = 0.03
            elif y >= (68 + 2 * math.sin(x / 13.0)):
                world.lu[y, x] = 2 # Urban
                world.fuel[y, x] = 0.12 + 0.06 * rng.rand()
            elif y >= (44 + 4 * math.sin(x / 9.0) + 2 * math.sin(x / 4.3)):
                world.lu[y, x] = 3 # WUI
                world.fuel[y, x] = 0.55 + 0.4 * canyon + 0.1 * rng.rand()
            else:
                world.lu[y, x] = 4 # Chaparral
                world.fuel[y, x] = 0.85 + 0.15 * rng.rand()

    # 2. Road Network
    node_map = {}
    def get_node(x: float, y: float, is_exit: bool = False) -> int:
        for idx, n in enumerate(world.nodes):
            if abs(n['x'] - x) < 0.6 and abs(n['y'] - y) < 0.6:
                if is_exit:
                    n['exit'] = True
                return idx
        idx = len(world.nodes)
        world.nodes.append({'id': idx, 'x': x, 'y': y, 'out': [], 'inn': [], 'exit': is_exit, 'local': False})
        return idx

    def add_edge(u: int, v: int, lanes: int, speed: float, road_type: str, name: str):
        A = world.nodes[u]
        B = world.nodes[v]
        dx = B['x'] - A['x']
        dy = B['y'] - A['y']
        dist = math.hypot(dx, dy)
        cells = []
        n_pts = max(1, int(math.ceil(dist * 2)))
        for i in range(n_pts + 1):
            cx = int(round(A['x'] + dx * i / n_pts))
            cy = int(round(A['y'] + dy * i / n_pts))
            if 0 <= cx < W and 0 <= cy < H:
                c = cy * W + cx
                if c not in cells:
                    cells.append(c)
                    world.road[cy, cx] = 1
                    world.cell_edges.setdefault(c, []).append(len(world.edges))

        eid = len(world.edges)
        edge = {
            'id': eid, 'from': u, 'to': v, 'len': dist * CELL,
            'lanes': lanes, 'speed': speed, 'type': road_type, 'name': name,
            'cells': cells, 'mx': (A['x'] + B['x']) / 2.0, 'my': (A['y'] + B['y']) / 2.0,
            'tt': max(1, int(round(dist * CELL / speed / DT)))
        }
        world.edges.append(edge)
        A['out'].append(eid)
        B['inn'].append(eid)
        if road_type != 'hwy':
            A['local'] = True
            B['local'] = True

    # Main Highway & Exits
    for x in range(0, 150, 15):
        cy_a = (90 + 3 * math.sin(x / 17.0) + 1.5 * math.sin(x / 7.0 + 1.0)) - 5
        cy_b = (90 + 3 * math.sin((x + 15) / 17.0) + 1.5 * math.sin((x + 15) / 7.0 + 1.0)) - 5
        u = get_node(x, cy_a, is_exit=(x == 0))
        v = get_node(x + 15, cy_b, is_exit=(x + 15 >= 150))
        add_edge(u, v, 2, 27.0, 'hwy', 'Coast Highway')
        add_edge(v, u, 2, 27.0, 'hwy', 'Coast Highway')

    # Canyon Arterials
    art_x = [22, 52, 86, 116, 146]
    for i, ax in enumerate(art_x):
        u_top = get_node(ax, 46)
        u_mid = get_node(ax, 68)
        u_bot = get_node(ax, 85)
        name = f"Canyon Corridor {i+1}"
        for (a, b) in [(u_top, u_mid), (u_mid, u_bot)]:
            add_edge(a, b, 1, 15.0, 'art', name)
            add_edge(b, a, 1, 15.0, 'art', name)

    # 3. Evacuation Zones
    zones = [
        {'id': 'F1', 'x0': 0, 'x1': 37, 'foot': True},
        {'id': 'F2', 'x0': 37, 'x1': 70, 'foot': True},
        {'id': 'F3', 'x0': 70, 'x1': 101, 'foot': True},
        {'id': 'F4', 'x0': 101, 'x1': 131, 'foot': True},
        {'id': 'F5', 'x0': 131, 'x1': 160, 'foot': True},
        {'id': 'U1', 'x0': 0, 'x1': 53, 'foot': False},
        {'id': 'U2', 'x0': 53, 'x1': 106, 'foot': False},
        {'id': 'U3', 'x0': 106, 'x1': 160, 'foot': False},
    ]
    world.zones = zones
    world.zone_blocks = [set() for _ in range(len(zones))]

    # 4. Household placement
    h_idx = 0
    for y in range(45, 88, 3):
        for x in range(5, 155, 4):
            if world.lu[y, x] in (2, 3): # Urban or WUI
                b = (y // BS) * world.BW + (x // BS)
                # Assign to closest node
                best_node = 0
                best_dist = float('inf')
                for n in world.nodes:
                    d = math.hypot(n['x'] - x, n['y'] - y)
                    if d < best_dist:
                        best_dist = d
                        best_node = n['id']
                
                # Determine zone
                foot = y < 65
                assigned_zone = 0
                for zi, z in enumerate(zones):
                    if z['foot'] == foot and z['x0'] <= x < z['x1']:
                        assigned_zone = zi
                        break

                home = {
                    'id': h_idx, 'x': x, 'y': y, 'fx': float(x), 'fy': float(y),
                    'node': best_node, 'b': b, 'zone': assigned_zone, 'spur': False
                }
                world.homes.append(home)
                world.cell_homes.setdefault(y * W + x, []).append(h_idx)
                world.zone_blocks[assigned_zone].add(b)
                h_idx += 1

    # 5. Slope factors & Exit distances
    for y in range(H):
        for x in range(W):
            c_elev = world.elev[y, x]
            for k in range(8):
                nx = x + DIRS[k][0]
                ny = y + DIRS[k][1]
                if 0 <= nx < W and 0 <= ny < H:
                    dist = CELL if k < 4 else CELL * 1.4142
                    s = (world.elev[ny, nx] - c_elev) / dist
                    world.sf[y, x, k] = math.exp(max(-1.5, min(1.5, 3.0 * s)))

    # Compute reverse Dijkstra for dist_exit
    import heapq
    dist_exit = np.full(len(world.nodes), float('inf'))
    pq = []
    for n in world.nodes:
        if n['exit']:
            dist_exit[n['id']] = 0.0
            heapq.heappush(pq, (0.0, n['id']))

    while pq:
        d, u = heapq.heappop(pq)
        if d > dist_exit[u]:
            continue
        for eid in world.nodes[u]['inn']:
            e = world.edges[eid]
            nd = d + e['len'] / e['speed']
            if nd < dist_exit[e['from']]:
                dist_exit[e['from']] = nd
                heapq.heappush(pq, (nd, e['from']))

    world.dist_exit = dist_exit
    
    # Ignition candidates in chaparral foothills
    for y in range(25, 45):
        for x in range(10, 150):
            if world.lu[y, x] == 4 and world.fuel[y, x] > 0.8:
                world.ign_candidates.append(y * W + x)

    return world


def load_overture_world(data_dir: str = "sb_overture/south_coast") -> World:
    """
    Loads real Overture South Coast GeoJSON files and builds a World topology.
    Falls back to build_synthetic_world if files are missing.
    """
    seg_path = os.path.join(data_dir, "segments.geojson")
    if not os.path.exists(seg_path):
        print(f"Overture data not found at {seg_path}; using synthetic foothill world.")
        return build_synthetic_world()

    # Santa Barbara South Coast bounding box
    bbox = {'w': -119.78, 's': 34.39, 'e': -119.56, 'n': 34.51}
    grid = Grid(bbox)
    world = World(grid.W, grid.H, grid)
    
    # Elevation: approximate foothill gradient from coast (south) to mountain crest (north)
    for y in range(grid.H):
        for x in range(grid.W):
            lat, lon = grid.to_latlng(x, y)
            elev = max(0.0, (lat - 34.39) * 8000.0)
            world.elev[y, x] = elev
            world.fuel[y, x] = 0.85 if elev > 100 else 0.25
            world.lu[y, x] = 4 if elev > 100 else 2

    print(f"Loading Overture road segments from {seg_path}...")
    with open(seg_path, 'r', encoding='utf-8') as f:
        seg_data = json.load(f)

    node_coords = {}
    def get_node(gx: float, gy: float, is_exit: bool = False) -> int:
        key = (round(gx, 1), round(gy, 1))
        if key in node_coords:
            idx = node_coords[key]
            if is_exit:
                world.nodes[idx]['exit'] = True
            return idx
        idx = len(world.nodes)
        node_coords[key] = idx
        world.nodes.append({'id': idx, 'x': gx, 'y': gy, 'out': [], 'inn': [], 'exit': is_exit, 'local': False})
        return idx

    for feat in seg_data.get('features', []):
        geom = feat.get('geometry', {})
        props = feat.get('properties', {})
        coords = geom.get('coordinates', [])
        if not coords or geom.get('type') != 'LineString':
            continue

        hw = props.get('class', 'residential')
        road_type = CLS.get(hw, 'local')
        speed = MPH.get(hw, 25) * 0.44704 # m/s
        lanes = 2 if road_type in ('hwy', 'art') else 1

        pts = []
        for lon, lat in coords:
            gx, gy = grid.to_grid(lat, lon)
            pts.append((gx, gy))

        if len(pts) < 2:
            continue

        u = get_node(pts[0][0], pts[0][1], is_exit=(pts[0][0] < 2 or pts[0][0] > grid.W - 2))
        v = get_node(pts[-1][0], pts[-1][1], is_exit=(pts[-1][0] < 2 or pts[-1][0] > grid.W - 2))
        if u == v:
            continue

        dist = math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]) * CELL
        eid = len(world.edges)
        edge = {
            'id': eid, 'from': u, 'to': v, 'len': max(10.0, dist),
            'lanes': lanes, 'speed': speed, 'type': road_type,
            'name': props.get('name', 'Road'), 'cells': [],
            'mx': (pts[0][0] + pts[-1][0]) / 2.0, 'my': (pts[0][1] + pts[-1][1]) / 2.0,
            'tt': max(1, int(round(dist / speed / DT)))
        }
        world.edges.append(edge)
        world.nodes[u]['out'].append(eid)
        world.nodes[v]['inn'].append(eid)

    # Evacuation zones (39 zones or 8 macro zones)
    world.zones = [{'id': f"SBC-{100+i}", 'foot': i < 20} for i in range(39)]
    world.zone_blocks = [set() for _ in range(len(world.zones))]

    # Distribute households near road intersections
    h_idx = 0
    for n in world.nodes[::3]:
        x, y = int(round(n['x'])), int(round(n['y']))
        if 0 <= x < grid.W and 0 <= y < grid.H:
            zi = (x * 39 // grid.W) % len(world.zones)
            b = (y // BS) * world.BW + (x // BS)
            world.homes.append({
                'id': h_idx, 'x': x, 'y': y, 'fx': float(x), 'fy': float(y),
                'node': n['id'], 'b': b, 'zone': zi, 'spur': False
            })
            world.cell_homes.setdefault(y * grid.W + x, []).append(h_idx)
            world.zone_blocks[zi].add(b)
            h_idx += 1

    world.dist_exit = np.zeros(len(world.nodes), dtype=np.float64)
    print(f"Loaded real-world topology: {len(world.nodes)} intersections, {len(world.edges)} links, {len(world.homes)} households.")
    return world
