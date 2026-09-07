// MaxMind GeoLite2 lookups. Country comes from here (notoolkit does not
// provide it); the ASN database is optional and only used as a fallback when
// notoolkit is unavailable, so the map and country breakdowns keep working.

import fs from 'node:fs';
import maxmind from 'maxmind';
import { config } from '../config.js';
import { logger } from '../util/log.js';

const log = logger('maxmind');

let countryReader = null;
let asnReader = null;
let loaded = false;

export const maxmindStatus = {
  countryDb: false,
  asnDb: false,
  error: null,
};

export async function initMaxmind() {
  if (loaded) return;
  loaded = true;
  if (!config.maxmind.enabled) {
    log.info('maxmind disabled by configuration');
    return;
  }
  for (const [file, kind] of [
    [config.maxmind.countryDb, 'country'],
    [config.maxmind.asnDb, 'asn'],
  ]) {
    if (!file || !fs.existsSync(file)) {
      if (kind === 'country') {
        maxmindStatus.error = `GeoLite2 country database not found at ${file}`;
        log.warn('country database missing; country data will be unavailable', { file });
      }
      continue;
    }
    try {
      const reader = await maxmind.open(file, { watchForUpdates: true });
      if (kind === 'country') {
        countryReader = reader;
        maxmindStatus.countryDb = true;
        maxmindStatus.error = null;
      } else {
        asnReader = reader;
        maxmindStatus.asnDb = true;
      }
      log.info('loaded database', { kind, file });
    } catch (err) {
      log.error('failed to load database', { kind, file, err: String(err) });
      if (kind === 'country') maxmindStatus.error = String(err);
    }
  }
}

/** @returns {{country:string|null, country_name:string|null}} */
export function lookupCountry(ip) {
  if (!countryReader || !ip) return { country: null, country_name: null };
  try {
    const r = countryReader.get(ip);
    // Works with both GeoLite2-Country and GeoLite2-City databases.
    const c = r?.country ?? r?.registered_country ?? r?.represented_country;
    if (!c?.iso_code) return { country: null, country_name: null };
    return { country: c.iso_code, country_name: c.names?.en ?? c.iso_code };
  } catch {
    return { country: null, country_name: null };
  }
}

/** @returns {{asn:number|null, as_org:string|null}} */
export function lookupAsn(ip) {
  if (!asnReader || !ip) return { asn: null, as_org: null };
  try {
    const r = asnReader.get(ip);
    if (!r?.autonomous_system_number) return { asn: null, as_org: null };
    return {
      asn: r.autonomous_system_number,
      as_org: r.autonomous_system_organization ?? null,
    };
  } catch {
    return { asn: null, as_org: null };
  }
}
