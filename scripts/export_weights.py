"""
Exports trained PyTorch PPO weights to JSON and ONNX for client-side web execution.
"""

import json
import os
import torch

def export():
    pt_path = "checkpoints/ppo_wildfire.pt"
    if not os.path.exists(pt_path):
        print(f"Error: {pt_path} does not exist.")
        return

    checkpoint = torch.load(pt_path, map_location="cpu")
    state = checkpoint["model_state_dict"]
    
    weights = {
        "obs_dim": checkpoint["obs_dim"],
        "action_dim": checkpoint["action_dim"],
        "w1": state["shared.0.weight"].numpy().tolist(),
        "b1": state["shared.0.bias"].numpy().tolist(),
        "w2": state["shared.3.weight"].numpy().tolist(),
        "b2": state["shared.3.bias"].numpy().tolist(),
        "w_actor": state["actor.weight"].numpy().tolist(),
        "b_actor": state["actor.bias"].numpy().tolist()
    }
    
    out_json = "docs/model/policy_weights.json"
    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    with open(out_json, "w") as f:
        json.dump(weights, f)
    print(f"Exported JSON weights to {out_json}")

    # Also generate a standalone JS file src/rl_policy.js
    js_content = f"const RLPolicy = (function() {{\n  const W = {json.dumps(weights)};\n" + """
  function relu(arr) { return arr.map(x => Math.max(0, x)); }
  function sigmoid(arr) { return arr.map(x => 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, x))))); }
  function matvec(W, b, x) {
    const out = new Float32Array(W.length);
    for (let i = 0; i < W.length; i++) {
      let sum = b[i];
      const row = W[i];
      for (let j = 0; j < x.length; j++) sum += row[j] * x[j];
      out[i] = sum;
    }
    return out;
  }
  function predict(obs) {
    const h1 = relu(matvec(W.w1, W.b1, obs));
    const h2 = relu(matvec(W.w2, W.b2, h1));
    const logits = matvec(W.w_actor, W.b_actor, h2);
    return sigmoid(logits);
  }
  return { predict, obs_dim: W.obs_dim, action_dim: W.action_dim };
})();
if (typeof module !== 'undefined') module.exports = RLPolicy;
"""
    with open("src/rl_policy.js", "w") as f:
        f.write(js_content)
    print("Exported src/rl_policy.js")

if __name__ == "__main__":
    export()
