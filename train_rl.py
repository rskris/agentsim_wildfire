"""
Training and Evaluation CLI for Wildfire Evacuation RL Agent.
"""

import argparse
import os
import time
import numpy as np

from agentsim.env.wildfire_env import WildfireEvacEnv
from agentsim.engine.loader import build_synthetic_world, load_overture_world
from agentsim.models.ppo_agent import PPOAgent


def run_baseline_rule_policy(env: WildfireEvacEnv, trigger_km: float = 1.5, num_evals: int = 5) -> dict:
    """
    Evaluates the standard human rule-based heuristic:
    Order an evacuation zone as soon as fire perimeter enters the buffer distance.
    """
    print(f"\nEvaluating Rule-Based Baseline Policy (Buffer: {trigger_km} km) across {num_evals} fires...")
    losses = []
    safes = []
    rewards = []

    for ep in range(num_evals):
        obs, info = env.reset(seed=100 + ep)
        ep_rew = 0.0
        done = False
        
        while not done:
            action = np.zeros(env.action_space.n, dtype=np.int8)
            # Human policy: Order zone if fire within trigger_km
            for zi in range(env.nz):
                d_km = env.sim.get_zone_fire_distance(zi)
                if d_km <= trigger_km:
                    action[zi] = 1
            
            obs, reward, terminated, truncated, step_info = env.step(action)
            ep_rew += reward
            done = terminated or truncated

        losses.append(step_info["total_fail"])
        safes.append(step_info["total_safe"])
        rewards.append(ep_rew)

    mean_loss = float(np.mean(losses))
    mean_safe = float(np.mean(safes))
    mean_rew = float(np.mean(rewards))
    print(f"Baseline Results -> Mean Lost: {mean_loss:.1f} | Mean Safe: {mean_safe:.1f} | Mean Return: {mean_rew:.1f}")
    return {"loss": mean_loss, "safe": mean_safe, "reward": mean_rew}


def train_rl(
    total_episodes: int = 25,
    rollout_steps: int = 120,
    dataset: str = "synthetic",
    checkpoint_dir: str = "checkpoints"
):
    print("=" * 70)
    print("AgentSim Wildfire - Reinforcement Learning Policy Training")
    print("=" * 70)
    
    if dataset == "overture":
        world = load_overture_world("sb_overture/south_coast")
    else:
        world = build_synthetic_world()

    env = WildfireEvacEnv(world=world, decision_interval_ticks=30)
    obs_dim = env.observation_space.shape[0]
    action_dim = env.action_space.n
    
    print(f"Environment initialized: {len(world.zones)} Zones | {len(world.homes)} Households")
    print(f"Observation Dimension: {obs_dim} | Action Dimension: {action_dim}")

    # Evaluate Human Baseline first
    base_res = run_baseline_rule_policy(env, trigger_km=1.5, num_evals=5)

    agent = PPOAgent(obs_dim=obs_dim, action_dim=action_dim, lr=3e-4)

    obs_buf = []
    act_buf = []
    logp_buf = []
    rew_buf = []
    val_buf = []
    done_buf = []

    print(f"\nBeginning PPO Training for {total_episodes} Episodes...")
    start_time = time.time()

    for ep in range(1, total_episodes + 1):
        obs, info = env.reset(seed=ep * 7)
        ep_rew = 0.0
        done = False
        step_count = 0

        while not done:
            action, logp, val = agent.act(obs)
            next_obs, reward, terminated, truncated, step_info = env.step(action)
            done = terminated or truncated

            obs_buf.append(obs)
            act_buf.append(action)
            logp_buf.append(logp)
            rew_buf.append(reward)
            val_buf.append(val)
            done_buf.append(done)

            obs = next_obs
            ep_rew += reward
            step_count += 1

            # Update policy when rollout buffer is full
            if len(rew_buf) >= rollout_steps:
                _, _, next_val = agent.act(obs)
                loss_dict = agent.update(
                    np.array(obs_buf, dtype=np.float32),
                    np.array(act_buf, dtype=np.float32),
                    np.array(logp_buf, dtype=np.float32),
                    np.array(rew_buf, dtype=np.float32),
                    np.array(val_buf, dtype=np.float32),
                    np.array(done_buf, dtype=np.bool_),
                    next_val=next_val if not done else 0.0,
                    epochs=4,
                    batch_size=32
                )
                obs_buf.clear()
                act_buf.clear()
                logp_buf.clear()
                rew_buf.clear()
                val_buf.clear()
                done_buf.clear()

        if ep % 5 == 0 or ep == total_episodes:
            elapsed = time.time() - start_time
            print(
                f"Episode {ep:02d}/{total_episodes} | Return: {ep_rew:+8.1f} | "
                f"Safe: {step_info['total_safe']:4d} | Lost: {step_info['total_fail']:3d} | "
                f"Elapsed: {elapsed:.1f}s"
            )

    # Save model and export ONNX
    os.makedirs(checkpoint_dir, exist_ok=True)
    pt_path = os.path.join(checkpoint_dir, "ppo_wildfire.pt")
    onnx_path = os.path.join("docs", "model", "policy.onnx")
    agent.save(pt_path)
    agent.export_onnx(onnx_path)

    # Evaluate trained agent
    print("\nEvaluating Trained RL Agent across 5 Test Fires...")
    rl_losses, rl_safes, rl_rews = [], [], []
    for test_ep in range(5):
        obs, info = env.reset(seed=100 + test_ep)
        ep_rew = 0.0
        done = False
        while not done:
            action, _, _ = agent.act(obs)
            obs, reward, terminated, truncated, step_info = env.step((action > 0.5).astype(np.int8))
            ep_rew += reward
            done = terminated or truncated
        rl_losses.append(step_info["total_fail"])
        rl_safes.append(step_info["total_safe"])
        rl_rews.append(ep_rew)

    rl_loss_mean = float(np.mean(rl_losses))
    rl_safe_mean = float(np.mean(rl_safes))
    rl_rew_mean = float(np.mean(rl_rews))

    print("\n" + "=" * 70)
    print("FINAL BENCHMARK COMPARISON (5 Test Fires)")
    print("=" * 70)
    print(f"Policy                   | Mean Lost (Casualties) | Mean Safe Evacuated | Mean Return")
    print(f"Rule-Based (1.5km buffer)| {base_res['loss']:22.1f} | {base_res['safe']:19.1f} | {base_res['reward']:+11.1f}")
    print(f"Trained RL Agent (PPO)   | {rl_loss_mean:22.1f} | {rl_safe_mean:19.1f} | {rl_rew_mean:+11.1f}")
    print("=" * 70)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train Wildfire Evacuation RL Agent")
    parser.add_argument("--episodes", type=int, default=15, help="Number of training episodes")
    parser.add_argument("--dataset", type=str, default="synthetic", choices=["synthetic", "overture"], help="Dataset to train on")
    args = parser.parse_args()
    
    train_rl(total_episodes=args.episodes, dataset=args.dataset)
