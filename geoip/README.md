# GeoLite2 databases

Country data comes from MaxMind, because notoolkit.com provides ASN
information only. Put the `.mmdb` files here; this directory is mounted
read-only at `/geoip` inside both containers.

Expected files:

    GeoLite2-Country.mmdb     required for country stats and the world map
    GeoLite2-ASN.mmdb         optional; ASN fallback when notoolkit is down

## Getting them

1. Create a free GeoLite2 account at maxmind.com and generate a licence key.
2. Download the "GeoLite2 Country" and "GeoLite2 ASN" databases in MMDB format.
3. Extract the `.mmdb` file from each archive into this directory.

A one-liner, substituting your key:

    curl -sL "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&license_key=YOUR_KEY&suffix=tar.gz" \
      | tar -xz --strip-components=1 --wildcards '*/GeoLite2-Country.mmdb'

MaxMind updates these weekly; re-download periodically. The reader watches the
files, so a replaced database is picked up without restarting the containers.

Without these files the stack still runs — the country map is simply empty, and
the Health page says why.
