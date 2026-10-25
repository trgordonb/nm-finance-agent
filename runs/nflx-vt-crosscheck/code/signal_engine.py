# Vibe-trading sandbox run for the ArgusDesk NFLX rule (cross-check of step6_backtest.py).
# Graded window = the unseen 30% (2026-03-23 .. 2026-10-23) via warmup_bars = 350 (the split).
# Same driver rule as step 6: XLC@3, k=1.2695224285125732, hold=1, sign from TRAIN corr (neg -> contrarian).
# Signal contract: position at t is based on XLC(t-3) only -> lag-shifted, no look-ahead.
# Contract-clean: constants computed from the train window OUTSIDE the sandbox and embedded;
# mu/sd/sign are train-window only (the graded window never touches them).
import numpy as np
import pandas as pd

K = 1.2695224285125732     # HOLA-tuned on the train window only
HOLD = 1
LAG = 3
DRIVER = "XLC"
TARGET = "NFLX"

# train-window stats of the XLC log-return (rows 0..349 of qd_all.csv), computed locally
MU = 0.00065304199247143667
SD = 0.010997664916649991
SIGN = -1.0                # sign of train corr(XLC(t-3), NFLX(t)) = -0.0912


class SignalEngine:
    def generate(self, data_map):
        px = data_map["NFLX.US"]
        drv = data_map["XLC.US"]
        r_nflx = np.log(px["close"]).diff()
        r_xlc = np.log(drv["close"]).diff()
        idx = r_nflx.index
        z = (r_xlc.shift(LAG) - MU) / SD          # driver move known BEFORE day t
        sig = (SIGN * z > K).astype(float)
        for _ in range(HOLD - 1):
            sig = np.maximum(sig, sig.shift(1).fillna(0.0))
        sig = sig.reindex(idx).fillna(0.0)
        return {"NFLX.US": pd.Series(sig, index=idx)}
