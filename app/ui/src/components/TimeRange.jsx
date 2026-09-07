const RANGES = [
  ['1h', '1h'],
  ['6h', '6h'],
  ['24h', '24h'],
  ['7d', '7d'],
  ['30d', '30d'],
  ['90d', '90d'],
  ['365d', '1y'],
];

export function TimeRange({ value, onChange, retentionDays }) {
  return (
    <div className="seg" role="group" aria-label="Time range">
      {RANGES.map(([id, label]) => {
        // Do not offer a window longer than the configured retention period.
        const days = id.endsWith('d') ? parseInt(id, 10) : 1;
        const disabled = retentionDays ? days > retentionDays : false;
        return (
          <button
            key={id}
            className={value === id ? 'active' : ''}
            disabled={disabled}
            title={disabled ? `Beyond the ${retentionDays}-day retention period` : undefined}
            onClick={() => onChange(id)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
