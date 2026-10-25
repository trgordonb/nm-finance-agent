# Vibe-trading sandbox run for the ArgusDesk NFLX rule (cross-check of step6_backtest.py).
# Graded window = the unseen 30% (2026-03-23 .. 2026-10-23) via warmup_bars = split(350).
# Same driver rule as step 6: XLC@3, k=1.27, hold=1, sign from train corr (negative -> contrarian).
# Contract: no executable top-level statements at all (imports/defs only);
# all constants live inside functions. Signal at t uses XLC(t-3) only -> no look-ahead.
import os

import numpy as np
import pandas as pd


def _params():
    return {"k": 1.2695224285125732, "hold": 1, "lag": 3,
            "driver": "XLC", "target": "NFLX", "split": 350}


def _train_stats():
    p = _params()
    path = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "qd_all.csv"))
    rets = pd.read_csv(path, index_col="date", parse_dates=True)
    train = rets.iloc[: p["split"]]
    c = float(train[p["driver"]].shift(p["lag"]).corr(train[p["target"]]))
    sign = float(np.sign(c)) or 1.0     # train-window corr is negative -> contrarian after flip
    return float(train[p["driver"]].mean()), float(train[p["driver"]].std()), sign


class SignalEngine:
    def generate(self, data_map):
        p = _params()
        mu, sd, sign = _train_stats()
        px = data_map["NFLX.US"]
        drv = data_map["XLC.US"]
        r_nflx = np.log(px["close"]).diff()
        r_xlc = np.log(drv["close"]).diff()
        idx = r_nflx.index
        z = (r_xlc.shift(p["lag"]) - mu) / sd          # driver move known BEFORE day t
        sig = (sign * z > p["k"]).astype(float)
        for _ in range(p["hold"] - 1):
            sig = np.maximum(sig, sig.shift(1).fillna(0.0))
        sig = sig.reindex(idx).fillna(0.0)
        return {p["target"]: pd.Series(sig, index=idx)}
