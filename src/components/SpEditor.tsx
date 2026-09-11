'use client';

/**
 * Stat Point editor shared by the team slot editor and the damage calc.
 *
 * One row per stat: nature-aware label, base stat, a real range slider, a typed number field, a
 * Max button, and the live computed stat. Every input path goes through clampSpToBudget, so a
 * stat can never exceed 32 and the spread can never exceed 66; the header shows what is left.
 */
import {
  STAT_ORDER,
  STAT_LABEL,
  SP_PER_STAT_MAX,
  SP_TOTAL_MAX,
  clampSpToBudget,
  calcChampionsStats,
  natureMultiplier,
  type Stat,
  type SpSpread,
  type StatSpread,
} from '@/lib/calc/sp';

export default function SpEditor({
  sp,
  nature,
  baseStats,
  onChange,
  compact = false,
}: {
  sp: SpSpread;
  nature: string;
  /** Base stats for the live computed column; omitted → column hidden. */
  baseStats?: StatSpread;
  onChange: (sp: SpSpread) => void;
  /** Tighter rows for the calc panels. */
  compact?: boolean;
}) {
  const total = STAT_ORDER.reduce((sum, s) => sum + (sp[s] ?? 0), 0);
  const remaining = SP_TOTAL_MAX - total;
  const computed = baseStats ? calcChampionsStats(baseStats, sp, nature) : null;

  function set(stat: Stat, raw: number) {
    const next = clampSpToBudget(sp, stat, raw);
    if (next === (sp[stat] ?? 0)) return;
    onChange({ ...sp, [stat]: next });
  }

  const labelStyle: React.CSSProperties = { fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1, color: '#40406a' };
  const rowGap = compact ? 4 : 6;

  return (
    <div>
      {/* Header: total, remaining bar, reset */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: compact ? 6 : 8 }}>
        <div style={labelStyle}>Stat Points</div>
        <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }} title={`${total} of ${SP_TOTAL_MAX} used`}>
          <div style={{ width: `${(total / SP_TOTAL_MAX) * 100}%`, height: '100%', background: total > SP_TOTAL_MAX ? '#f87171' : '#6366f1', transition: 'width 0.15s' }} />
        </div>
        <span style={{ fontSize: 11, fontWeight: 800, color: remaining === 0 ? '#34d399' : remaining < 0 ? '#f87171' : '#7070a8', whiteSpace: 'nowrap' }}>
          {total} / {SP_TOTAL_MAX}{remaining > 0 ? <span style={{ color: '#50508a', fontWeight: 700 }}> · {remaining} left</span> : null}
        </span>
        <button
          type="button"
          onClick={() => onChange({})}
          disabled={total === 0}
          style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid rgba(99,102,241,0.2)', background: 'transparent', color: total === 0 ? '#35355a' : '#7070a8', fontSize: 10, fontWeight: 800, cursor: total === 0 ? 'default' : 'pointer' }}
        >
          Reset
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: rowGap }}>
        {STAT_ORDER.map((s) => {
          const mult = natureMultiplier(nature, s);
          const boost = s !== 'hp' && mult > 1;
          const drop = s !== 'hp' && mult < 1;
          const val = sp[s] ?? 0;
          const color = boost ? '#34d399' : drop ? '#f87171' : '#6366f1';
          const labelColor = boost ? '#34d399' : drop ? '#f87171' : '#6868a8';
          const maxHere = Math.min(SP_PER_STAT_MAX, val + Math.max(0, remaining));
          const pct = (val / SP_PER_STAT_MAX) * 100;
          return (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: compact ? 6 : 8 }}>
              <span style={{ width: compact ? 30 : 36, fontSize: 11, fontWeight: 800, color: labelColor, flexShrink: 0 }} title={boost ? `${nature} raises ${STAT_LABEL[s]}` : drop ? `${nature} lowers ${STAT_LABEL[s]}` : undefined}>
                {STAT_LABEL[s]}{boost ? '+' : drop ? '−' : ''}
              </span>
              {baseStats && (
                <span style={{ width: 24, textAlign: 'right', fontSize: 10, color: '#35355a', flexShrink: 0, fontWeight: 600 }} title="Base stat">{baseStats[s]}</span>
              )}
              <input
                type="range"
                className="sp-range"
                min={0}
                max={SP_PER_STAT_MAX}
                step={1}
                value={val}
                onChange={(e) => set(s, Number(e.target.value))}
                aria-label={`${STAT_LABEL[s]} stat points`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  accentColor: color,
                  // Filled track up to the current value; the rest of the track is dim.
                  background: `linear-gradient(90deg, ${color} 0%, ${color} ${pct}%, rgba(255,255,255,0.07) ${pct}%, rgba(255,255,255,0.07) 100%)`,
                } as React.CSSProperties}
              />
              <input
                type="number"
                min={0}
                max={SP_PER_STAT_MAX}
                value={val}
                onChange={(e) => set(s, e.target.value === '' ? 0 : Number(e.target.value))}
                onFocus={(e) => e.currentTarget.select()}
                onWheel={(e) => e.currentTarget.blur()}
                aria-label={`${STAT_LABEL[s]} stat points, typed`}
                style={{ width: 40, textAlign: 'center', background: 'rgba(4,4,14,0.85)', border: '1px solid rgba(99,102,241,0.18)', borderRadius: 6, padding: '3px 2px', color: val > 0 ? '#e0e0f4' : '#545480', fontWeight: 800, fontSize: 11, outline: 'none', colorScheme: 'dark', flexShrink: 0 } as React.CSSProperties}
              />
              <button
                type="button"
                onClick={() => set(s, val === maxHere && val > 0 ? 0 : maxHere)}
                disabled={maxHere === 0 && val === 0}
                title={val === maxHere && val > 0 ? 'Clear' : `Put ${maxHere} here`}
                style={{ width: 30, padding: '3px 0', borderRadius: 6, border: '1px solid rgba(99,102,241,0.18)', background: 'transparent', color: val === maxHere && val > 0 ? '#7070a8' : '#8b8bf0', fontSize: 9, fontWeight: 800, cursor: 'pointer', flexShrink: 0 }}
              >
                {val === maxHere && val > 0 ? '0' : 'Max'}
              </button>
              {computed && (
                <span style={{ width: 30, textAlign: 'right', fontFamily: "'Courier New', monospace", fontSize: 12, fontWeight: 700, color: boost ? '#34d399' : drop ? '#f87171' : '#d0d0f0', flexShrink: 0 }} title="Final stat at Level 50">
                  {computed[s]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
