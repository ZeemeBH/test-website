/**
 * @file GeoService.ts
 * All PostGIS spatial queries live here.
 *
 * Why raw SQL instead of TypeORM query builder for spatial operations:
 *  - TypeORM's spatial query builder support is minimal.
 *  - Raw SQL gives us full access to PostGIS functions (ST_DWithin,
 *    ST_Distance, ST_AsGeoJSON, ST_MakePoint, etc.) without workarounds.
 *  - Parameterised queries prevent SQL injection.
 */

import { DataSource } from 'typeorm';
import type { GeoPoint, NearbyDriver } from '../../types/interfaces';
import { VehicleType } from '../../types/enums';
import { logger } from '../../utils/logger';

export class GeoService {
  constructor(private readonly db: DataSource) {}

  // ─────────────────────────────────────────────────────────────────────────
  // WKT helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Converts a GeoPoint to PostGIS WKT understood by ST_GeographyFromText.
   * 'SRID=4326;POINT(<lng> <lat>)'
   */
  static toWkt(point: GeoPoint): string {
    const [lng, lat] = point.coordinates;
    return `SRID=4326;POINT(${lng} ${lat})`;
  }

  /**
   * Parses a GeoJSON string returned by PostGIS ST_AsGeoJSON() into GeoPoint.
   */
  static fromGeoJson(geoJson: string): GeoPoint {
    const parsed = JSON.parse(geoJson) as { type: string; coordinates: [number, number] };
    return {
      type: 'Point',
      coordinates: [parsed.coordinates[0], parsed.coordinates[1]],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Driver proximity search (core dispatch query)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns available, online drivers within `radiusKm` of `origin`,
   * ordered by ascending distance.
   *
   * Uses ST_DWithin on GEOGRAPHY columns — this is sphere-aware so the
   * radius is in metres on the earth's surface, not a flat projection.
   *
   * @param origin      Pickup location
   * @param radiusKm    Search radius in km
   * @param vehicleType Optional filter — only return matching vehicle type
   * @param limit       Max results (default 10)
   */
  async findNearbyDrivers(
    origin: GeoPoint,
    radiusKm: number,
    vehicleType?: VehicleType,
    limit = 10,
  ): Promise<NearbyDriver[]> {
    const radiusMetres = radiusKm * 1000;
    const wkt = GeoService.toWkt(origin);

    const params: (string | number)[] = [wkt, radiusMetres, limit];
    let vehicleFilter = '';

    if (vehicleType) {
      params.push(vehicleType);
      vehicleFilter = `AND d.vehicle_type = $${params.length}`;
    }

    const sql = `
      SELECT
        d.id                                                AS "driverId",
        ST_Distance(d.current_location, $1::geography)     AS "distanceMeters",
        ST_AsGeoJSON(d.current_location)                   AS "locationGeoJson",
        d.vehicle_type                                     AS "vehicleType"
      FROM drivers d
      WHERE
        d.is_online     = TRUE
        AND d.is_available = TRUE
        AND d.status       = 'ACTIVE'
        AND d.current_location IS NOT NULL
        AND ST_DWithin(d.current_location, $1::geography, $2)
        ${vehicleFilter}
      ORDER BY "distanceMeters" ASC
      LIMIT $3
    `;

    try {
      const rows = await this.db.query(sql, params);
      return rows.map(
        (r: { driverId: string; distanceMeters: string; locationGeoJson: string; vehicleType: VehicleType }) => ({
          driverId: r.driverId,
          distanceMeters: parseFloat(r.distanceMeters),
          location: GeoService.fromGeoJson(r.locationGeoJson),
          vehicleType: r.vehicleType,
        }),
      );
    } catch (err) {
      logger.error({ err }, '[GeoService] findNearbyDrivers failed');
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Distance calculation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the spheroid distance in metres between two GeoPoints.
   * Uses ST_Distance on GEOGRAPHY type — no manual Haversine needed.
   */
  async distanceMetres(a: GeoPoint, b: GeoPoint): Promise<number> {
    const sql = `SELECT ST_Distance($1::geography, $2::geography) AS dist`;
    const rows = await this.db.query(sql, [GeoService.toWkt(a), GeoService.toWkt(b)]);
    return parseFloat(rows[0].dist);
  }

  /**
   * Convenience wrapper returning distance in km, rounded to 3 d.p.
   */
  async distanceKm(a: GeoPoint, b: GeoPoint): Promise<number> {
    const metres = await this.distanceMetres(a, b);
    return Math.round((metres / 1000) * 1000) / 1000;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Driver location update
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Atomically updates a driver's PostGIS location column and last-seen timestamp.
   * Called from the WebSocket location handler on every driver heartbeat.
   */
  async updateDriverLocation(driverId: string, point: GeoPoint): Promise<void> {
    const wkt = GeoService.toWkt(point);
    const sql = `
      UPDATE drivers
      SET
        current_location    = $1::geography,
        last_location_update = NOW()
      WHERE id = $2
    `;
    await this.db.query(sql, [wkt, driverId]);
  }
}
