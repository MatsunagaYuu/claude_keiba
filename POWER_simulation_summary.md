# POWER Value Simulation Analysis - February 2026 Turf Races

## Overview
This analysis compares different POWER values (1.5, 1.7, 1.8, 2.0) and an asymmetric variant on actual February 2026 turf races.

## POWER_K Calibration
All POWER_K values were calibrated using the Equinox reference point:
- timeDiff = 3.26 seconds
- Target points = 21
- Formula: POWER_K = 21 / (3.26^POWER)

Results:
- POWER=1.5: 3.5677
- POWER=1.7: 2.8168
- POWER=1.8: 2.5028
- POWER=2.0: 1.9760

## Key Observations

### 1. 未勝利 Class (3歳未勝利 芝1400)
- **Negative timeDiff dominates**: All horses were slower than base time
- **Range**: timeDiff from -1.17 to -3.93 seconds
- **Index spread increases with higher POWER**: 
  - POWER=1.5: 240-274 (34 point range)
  - POWER=2.0: 236-276 (40 point range)
- **Effect**: Higher POWER values amplify differences for slower horses

### 2. 1勝クラス (4歳以上1勝クラス 芝1600)
- **All negative timeDiff**: Range -0.18 to -1.98 seconds
- **Very tight clustering**: Most horses within 293-300 range
- **Minimal POWER impact**: Differences of only 1-3 points across POWER values
- **Asymmetric matches POWER=1.8**: Since all timeDiff are negative

### 3. 2勝クラス (4歳以上2勝クラス 芝1600)
- **Mix of positive and negative timeDiff**: Range +0.74 to -1.96 seconds
- **Winner's advantage**: エフォートレス (1st) had positive timeDiff
  - idx(1.5) = 308, idx(2.0) = 306
  - **Lower POWER favors faster horses more**
- **Asymmetric shows advantage**: For winner, asymmetric (308) matches POWER=1.5

### 4. オープン Class (3歳オープン 芝1600)
- **Narrow timeDiff range**: +0.34 to -1.96 seconds
- **High base clustering**: All horses 303-316 range
- **Winner benefit**: ドリームコア at 316 (POWER=1.5) vs 315 (POWER=2.0)
- **Class quality visible**: Even slow horses maintain 303+ indices

## Asymmetric POWER Analysis

The asymmetric variant uses:
- POWER=1.5 for positive timeDiff (faster than base)
- POWER=1.8 for negative timeDiff (slower than base)

### Advantages:
1. **Rewards fast performances more**: Matches POWER=1.5 for positive timeDiff
2. **Still penalizes slow horses**: Uses POWER=1.8 for negative timeDiff
3. **Natural differentiation**: Winners in 2勝クラス and OP benefit most

### Comparison with fixed POWER values:
- **vs POWER=1.5**: Identical for fast horses, more penalty for slow horses
- **vs POWER=1.8**: More reward for fast horses, identical for slow horses
- **vs POWER=2.0**: More reward for fast horses, less penalty for slow horses

## Conclusions

### 1. Impact varies by class and race quality:
- **Low classes with slow times**: Higher POWER creates bigger spreads
- **High classes with tight times**: POWER choice matters less

### 2. POWER=1.5 (current) characteristics:
- Rewards fast horses most
- Gentler on slow horses
- May not differentiate enough in low-class races

### 3. POWER=1.8-2.0 characteristics:
- Creates stronger penalties for slow horses
- Compresses rewards for fast horses
- Better differentiation in weak fields

### 4. Asymmetric POWER advantages:
- **Best of both worlds**: Rewards excellence, penalizes mediocrity
- **Practical recommendation**: Consider for more balanced evaluation
- **Natural logic**: Fast is impressive, slow is problematic

## Recommendation

**Consider moving to asymmetric POWER (1.5/1.8) or POWER=1.8** because:

1. Current POWER=1.5 may be too gentle on slow horses
2. Asymmetric preserves reward for fast horses while better differentiating slow ones
3. In races with positive timeDiff winners, asymmetric matches current behavior
4. In races with all-negative timeDiff, provides better spread

The choice between asymmetric and fixed POWER=1.8 depends on philosophy:
- **Asymmetric**: If you believe fast performances deserve extra reward
- **POWER=1.8**: If you want consistent treatment regardless of direction
