// Choropleth of request origins. Rendered as plain SVG from the bundled
// world-atlas TopoJSON — no tile server, no external requests, so it works on
// an air-gapped host and satisfies the app's strict CSP.

import { useEffect, useMemo, useRef, useState } from 'react';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import worldTopo from 'world-atlas/countries-110m.json';
import { alphaToNumeric, countryName, flag, numericToAlpha } from '../lib/countries.js';
import { compact, num, pct } from '../lib/format.js';
import { Empty } from './ui.jsx';

const WIDTH = 900;
const HEIGHT = 460;

// Perceptually ordered ramp from the panel background to the accent hue.
const RAMP = ['#12303a', '#12464b', '#116057', '#0f7a5e', '#149a6d', '#2dd4a7'];
const RAMP_LIGHT = ['#dcefe8', '#b5e0d1', '#83cdb5', '#4fb797', '#1f9e7b', '#0b7a5b'];

const land = feature(worldTopo, worldTopo.objects.countries);

export function WorldMap({ rows, height = HEIGHT }) {
  const [tip, setTip] = useState(null);
  const wrapRef = useRef(null);
  const [light, setLight] = useState(
    () => document.documentElement.getAttribute('data-theme') === 'light'
  );

  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setLight(el.getAttribute('data-theme') === 'light'));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const { byNumeric, max, total, paths } = useMemo(() => {
    const byNumeric = new Map();
    let max = 0;
    let total = 0;
    for (const r of rows ?? []) {
      total += r.requests;
      const numericId = alphaToNumeric.get(r.country);
      if (!numericId) continue; // 'XX' unknown / 'ZZ' private — counted, not drawn
      const key = String(Number(numericId));
      const next = (byNumeric.get(key) ?? 0) + r.requests;
      byNumeric.set(key, next);
      if (next > max) max = next;
    }
    const projection = geoNaturalEarth1().fitSize([WIDTH, HEIGHT], land);
    const pathGen = geoPath(projection);
    const paths = land.features.map((f) => ({
      id: String(Number(f.id)),
      d: pathGen(f),
    }));
    return { byNumeric, max, total, paths };
  }, [rows]);

  if (!rows?.length) return <Empty>No geographic data yet.</Empty>;

  const ramp = light ? RAMP_LIGHT : RAMP;
  const emptyFill = light ? '#e8ecf1' : '#1b2431';

  // Log scale: a handful of huge sources would otherwise flatten everything.
  const colorFor = (v) => {
    if (!v) return emptyFill;
    const t = Math.log10(v + 1) / Math.log10(max + 1);
    return ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
  };

  const move = (evt, id) => {
    const v = byNumeric.get(id) ?? 0;
    const alpha = numericToAlpha.get(id);
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    setTip({
      x: evt.clientX - box.left,
      y: evt.clientY - box.top,
      name: alpha ? countryName(alpha) : 'Unknown',
      flag: alpha ? flag(alpha) : '',
      value: v,
    });
  };

  return (
    <div className="map-wrap" ref={wrapRef} onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ maxHeight: height }} role="img"
           aria-label="Requests by country">
        <g>
          {paths.map((p) => (
            <path
              key={p.id}
              className="map-country"
              d={p.d}
              fill={colorFor(byNumeric.get(p.id) ?? 0)}
              onMouseMove={(e) => move(e, p.id)}
            />
          ))}
        </g>
      </svg>

      {tip && (
        <div
          className="map-tip"
          style={{
            left: Math.min(tip.x + 12, WIDTH - 130),
            top: tip.y + 12,
          }}
        >
          <strong>
            {tip.flag} {tip.name}
          </strong>
          <div className="dim">
            {num(tip.value)} requests {total ? `· ${pct(tip.value / total)}` : ''}
          </div>
        </div>
      )}

      <div className="map-legend" style={{ padding: '8px 2px 0' }}>
        <span>Fewer</span>
        <span
          className="scale"
          style={{ background: `linear-gradient(90deg, ${ramp.join(',')})` }}
        />
        <span>More (up to {compact(max)})</span>
      </div>
    </div>
  );
}
