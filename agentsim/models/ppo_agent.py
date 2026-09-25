"""
Proximal Policy Optimization (PPO) Actor-Critic Agent for Wildfire Emergency Operations.
Supports multi-binary action spaces, GAE, action masking, and ONNX export.
"""

import os
from typing import Dict, List, Tuple, Any, Optional
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.distributions import Bernoulli


class ActorCritic(nn.Module):
    """
    Dual-head MLP Actor-Critic network.
    Actor outputs logits for Bernoulli multi-binary actions (zone orders + contraflow).
    Critic outputs scalar state value V(s).
    """
    def __init__(self, obs_dim: int, action_dim: int, hidden_dim: int = 128):
        super().__init__()
        self.obs_dim = obs_dim
        self.action_dim = action_dim
        
        # Shared feature representation
        self.shared = nn.Sequential(
            nn.Linear(obs_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.ReLU()
        )
        
        # Policy head (Actor)
        self.actor = nn.Linear(hidden_dim // 2, action_dim)
        
        # Value head (Critic)
        self.critic = nn.Linear(hidden_dim // 2, 1)

    def forward(self, obs: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        features = self.shared(obs)
        logits = self.actor(features)
        val = self.critic(features)
        return logits, val

    def get_action_and_value(
        self, obs: torch.Tensor, action: Optional[torch.Tensor] = None, mask: Optional[torch.Tensor] = None
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        logits, val = self.forward(obs)
        
        # Optional action masking: forbid re-ordering zones that are already ordered
        if mask is not None:
            logits = logits.masked_fill(~mask, -1e8)
            
        dist = Bernoulli(logits=logits)
        if action is None:
            action = dist.sample()
            
        log_prob = dist.log_prob(action).sum(dim=-1)
        entropy = dist.entropy().sum(dim=-1)
        return action, log_prob, entropy, val.squeeze(-1)


class PPOAgent:
    def __init__(
        self,
        obs_dim: int,
        action_dim: int,
        lr: float = 3e-4,
        gamma: float = 0.99,
        gae_lambda: float = 0.95,
        clip_coef: float = 0.2,
        ent_coef: float = 0.01,
        vf_coef: float = 0.5,
        max_grad_norm: float = 0.5,
        device: str = "cpu"
    ):
        self.obs_dim = obs_dim
        self.action_dim = action_dim
        self.gamma = gamma
        self.gae_lambda = gae_lambda
        self.clip_coef = clip_coef
        self.ent_coef = ent_coef
        self.vf_coef = vf_coef
        self.max_grad_norm = max_grad_norm
        self.device = torch.device(device)
        
        self.network = ActorCritic(obs_dim, action_dim).to(self.device)
        self.optimizer = optim.Adam(self.network.parameters(), lr=lr, eps=1e-5)

    def act(self, obs: np.ndarray) -> Tuple[np.ndarray, float, float]:
        with torch.no_grad():
            obs_t = torch.as_tensor(obs, dtype=torch.float32, device=self.device).unsqueeze(0)
            action, log_prob, _, val = self.network.get_action_and_value(obs_t)
            return action.squeeze(0).cpu().numpy(), log_prob.item(), val.item()

    def update(
        self,
        obs_buf: np.ndarray,
        act_buf: np.ndarray,
        logp_buf: np.ndarray,
        rew_buf: np.ndarray,
        val_buf: np.ndarray,
        done_buf: np.ndarray,
        next_val: float,
        epochs: int = 4,
        batch_size: int = 64
    ) -> Dict[str, float]:
        """
        Updates policy and value function parameters using Generalized Advantage Estimation.
        """
        n_steps = len(rew_buf)
        advantages = np.zeros(n_steps, dtype=np.float32)
        last_gae = 0.0
        
        for t in reversed(range(n_steps)):
            if t == n_steps - 1:
                next_non_terminal = 1.0 - float(done_buf[t])
                next_value = next_val
            else:
                next_non_terminal = 1.0 - float(done_buf[t])
                next_value = val_buf[t + 1]
                
            delta = rew_buf[t] + self.gamma * next_value * next_non_terminal - val_buf[t]
            advantages[t] = last_gae = delta + self.gamma * self.gae_lambda * next_non_terminal * last_gae
            
        returns = advantages + val_buf
        
        # Convert to PyTorch tensors
        b_obs = torch.as_tensor(obs_buf, dtype=torch.float32, device=self.device)
        b_act = torch.as_tensor(act_buf, dtype=torch.float32, device=self.device)
        b_logp = torch.as_tensor(logp_buf, dtype=torch.float32, device=self.device)
        b_adv = torch.as_tensor(advantages, dtype=torch.float32, device=self.device)
        b_ret = torch.as_tensor(returns, dtype=torch.float32, device=self.device)
        
        # Normalize advantages
        b_adv = (b_adv - b_adv.mean()) / (b_adv.std() + 1e-8)
        
        indices = np.arange(n_steps)
        total_pg_loss, total_v_loss, total_ent = 0.0, 0.0, 0.0
        n_updates = 0
        
        for _ in range(epochs):
            np.random.shuffle(indices)
            for start in range(0, n_steps, batch_size):
                end = start + batch_size
                batch_idx = indices[start:end]
                
                _, new_logp, entropy, new_val = self.network.get_action_and_value(b_obs[batch_idx], b_act[batch_idx])
                
                log_ratio = new_logp - b_logp[batch_idx]
                ratio = torch.exp(log_ratio)
                
                # Policy loss with PPO clipping
                mb_adv = b_adv[batch_idx]
                pg_loss1 = -mb_adv * ratio
                pg_loss2 = -mb_adv * torch.clamp(ratio, 1.0 - self.clip_coef, 1.0 + self.clip_coef)
                pg_loss = torch.max(pg_loss1, pg_loss2).mean()
                
                # Value loss
                v_loss = 0.5 * ((new_val - b_ret[batch_idx]) ** 2).mean()
                ent_loss = entropy.mean()
                
                loss = pg_loss - self.ent_coef * ent_loss + self.vf_coef * v_loss
                
                self.optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.network.parameters(), self.max_grad_norm)
                self.optimizer.step()
                
                total_pg_loss += pg_loss.item()
                total_v_loss += v_loss.item()
                total_ent += ent_loss.item()
                n_updates += 1

        return {
            "policy_loss": total_pg_loss / max(1, n_updates),
            "value_loss": total_v_loss / max(1, n_updates),
            "entropy": total_ent / max(1, n_updates)
        }

    def save(self, filepath: str):
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        torch.save({
            "obs_dim": self.obs_dim,
            "action_dim": self.action_dim,
            "model_state_dict": self.network.state_dict()
        }, filepath)
        print(f"Saved PPO model checkpoint to {filepath}")

    def load(self, filepath: str):
        checkpoint = torch.load(filepath, map_location=self.device)
        self.network.load_state_dict(checkpoint["model_state_dict"])
        print(f"Loaded PPO model checkpoint from {filepath}")

    def export_onnx(self, filepath: str):
        """
        Exports the actor network to ONNX format for zero-install client-side inference in web browsers.
        """
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        dummy_input = torch.randn(1, self.obs_dim, device=self.device)
        
        class ActorInference(nn.Module):
            def __init__(self, net):
                super().__init__()
                self.shared = net.shared
                self.actor = net.actor
            def forward(self, x):
                features = self.shared(x)
                logits = self.actor(features)
                # Output sigmoid probabilities [0, 1] for each zone and contraflow
                return torch.sigmoid(logits)

        actor_model = ActorInference(self.network).to(self.device)
        actor_model.eval()
        
        torch.onnx.export(
            actor_model,
            dummy_input,
            filepath,
            export_params=True,
            opset_version=14,
            do_constant_folding=True,
            input_names=['observation'],
            output_names=['action_probabilities'],
            dynamic_axes={'observation': {0: 'batch_size'}, 'action_probabilities': {0: 'batch_size'}}
        )
        print(f"Exported ONNX policy model to {filepath}")
