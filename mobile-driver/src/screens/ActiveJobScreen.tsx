/**
 * @file ActiveJobScreen.tsx
 * Driver's active delivery screen.
 *
 * ── Stages ────────────────────────────────────────────────────────────────
 *
 *  DRIVING_TO_PICKUP
 *    Map shows route from driver to pickup.
 *    "Mark Arrived" button visible.
 *
 *  ARRIVED_AT_PICKUP
 *    "Mark Picked Up" button visible.
 *    Driver confirms they have the package.
 *
 *  DRIVING_TO_DROPOFF
 *    Map shows route from pickup to dropoff.
 *    "Mark Delivered" button visible.
 *
 *  PROOF_CAPTURE
 *    expo-camera opens.  Driver MUST take a photo of the delivered item.
 *    Photo uploaded to POST /orders/:id/delivered as proof.
 *
 * ── Camera (Proof of Delivery) ────────────────────────────────────────────
 * We force the driver to take a photo before the delivery is marked
 * complete — this evidence is stored server-side and releases escrow.
 * The camera cannot be dismissed without either taking a photo or
 * navigating back (which keeps the order in IN_TRANSIT state).
 *
 * ── Map routing ───────────────────────────────────────────────────────────
 * react-native-maps + Directions API (via MapViewDirections or a manual
 * Polyline decoded from the Google Directions endpoint).
 * This implementation uses a stub Polyline for brevity — swap in
 * react-native-maps-directions in a production build.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DriverStackParamList } from '../types/navigation';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type JobStage =
  | 'DRIVING_TO_PICKUP'
  | 'ARRIVED_AT_PICKUP'
  | 'DRIVING_TO_DROPOFF'
  | 'PROOF_CAPTURE'
  | 'COMPLETE';

interface ActiveOrder {
  id: string;
  orderNumber: string;
  pickupAddress: { line1: string; city: string };
  dropoffAddress: { line1: string; city: string };
  pickupLocation: { coordinates: [number, number] };
  dropoffLocation: { coordinates: [number, number] };
  totalFare: number;
  currency: string;
  driverPayout: number;
  recipientName?: string;
  recipientPhoneE164?: string;
}

type Props = NativeStackScreenProps<DriverStackParamList, 'ActiveJob'>;

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// ─────────────────────────────────────────────────────────────────────────────
// Stage config
// ─────────────────────────────────────────────────────────────────────────────

const STAGE_CONFIG: Record<JobStage, { label: string; btnLabel: string; btnColour: string } | null> = {
  DRIVING_TO_PICKUP:  { label: 'Head to pickup',       btnLabel: 'Mark Arrived',    btnColour: '#f59e0b' },
  ARRIVED_AT_PICKUP:  { label: 'At pickup location',   btnLabel: 'Mark Picked Up',  btnColour: '#8b5cf6' },
  DRIVING_TO_DROPOFF: { label: 'Head to drop-off',     btnLabel: 'Mark Delivered',  btnColour: '#22c55e' },
  PROOF_CAPTURE:      null,
  COMPLETE:           null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ActiveJobScreen({ route, navigation }: Props) {
  const { orderId } = route.params as { orderId: string };

  const [order, setOrder] = useState<ActiveOrder | null>(null);
  const [stage, setStage] = useState<JobStage>('DRIVING_TO_PICKUP');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const mapRef = useRef<MapView>(null);

  // ── Fetch order ────────────────────────────────────────────────────────────

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${process.env.API_BASE_URL}/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${getAccessToken()}` },
        });
        const data = await res.json() as { success: boolean; data: ActiveOrder };
        if (data.success) {
          setOrder(data.data);
          // Fit map to pickup + dropoff
          setTimeout(() => {
            mapRef.current?.fitToCoordinates(
              [
                { latitude: data.data.pickupLocation.coordinates[1], longitude: data.data.pickupLocation.coordinates[0] },
                { latitude: data.data.dropoffLocation.coordinates[1], longitude: data.data.dropoffLocation.coordinates[0] },
              ],
              { edgePadding: { top: 60, right: 40, bottom: 200, left: 40 }, animated: true },
            );
          }, 500);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [orderId]);

  // ── Stage transitions ──────────────────────────────────────────────────────

  const handlePrimaryAction = useCallback(async () => {
    if (!order) return;

    setActionLoading(true);
    try {
      switch (stage) {
        case 'DRIVING_TO_PICKUP': {
          // POST /orders/:id/arrived
          const ok = await apiPost(`/orders/${orderId}/arrived`);
          if (ok) setStage('ARRIVED_AT_PICKUP');
          break;
        }
        case 'ARRIVED_AT_PICKUP': {
          // POST /orders/:id/picked-up
          const ok = await apiPost(`/orders/${orderId}/picked-up`);
          if (ok) {
            await apiPost(`/orders/${orderId}/in-transit`);
            setStage('DRIVING_TO_DROPOFF');
          }
          break;
        }
        case 'DRIVING_TO_DROPOFF': {
          // Check camera permission before opening camera
          if (!cameraPermission?.granted) {
            const { granted } = await requestCameraPermission();
            if (!granted) {
              Alert.alert('Camera Required', 'You must take a photo to complete the delivery.');
              return;
            }
          }
          setStage('PROOF_CAPTURE');
          break;
        }
        default:
          break;
      }
    } finally {
      setActionLoading(false);
    }
  }, [stage, orderId, order, cameraPermission, requestCameraPermission]);

  // ── Camera capture ─────────────────────────────────────────────────────────

  const handleTakePhoto = useCallback(async () => {
    if (!cameraRef.current) return;
    setActionLoading(true);

    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        base64: true,
        exif: false,
      });

      if (!photo?.base64) {
        Alert.alert('Error', 'Could not capture photo. Please try again.');
        return;
      }

      // POST /orders/:id/delivered with photo proof
      const res = await fetch(`${process.env.API_BASE_URL}/orders/${orderId}/delivered`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAccessToken()}` },
        body: JSON.stringify({
          type: 'PHOTO',
          photoUrls: [`data:image/jpeg;base64,${photo.base64}`],
          capturedAt: new Date().toISOString(),
        }),
      });

      const data = await res.json() as { success: boolean; message?: string };

      if (!data.success) {
        Alert.alert('Upload failed', data.message ?? 'Please retry.');
        return;
      }

      setStage('COMPLETE');
      Alert.alert(
        'Delivery Complete! 🎉',
        `Payout: ${order?.currency} ${order?.driverPayout?.toFixed(order?.currency === 'BHD' ? 3 : 2)}`,
        [{ text: 'View Summary', onPress: () => navigation.navigate('Dashboard') }],
      );
    } catch {
      Alert.alert('Network error', 'Please try again.');
    } finally {
      setActionLoading(false);
    }
  }, [orderId, order, navigation]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading || !order) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  // ── Camera mode ────────────────────────────────────────────────────────────

  if (stage === 'PROOF_CAPTURE') {
    return (
      <SafeAreaView style={styles.cameraContainer}>
        <CameraView ref={cameraRef} style={styles.camera} facing="back">
          {/* Overlay guide */}
          <View style={styles.cameraOverlay}>
            <Text style={styles.cameraInstruction}>
              📦 Take a clear photo of the delivered item
            </Text>
            <View style={styles.cameraFrame} />
            <View style={styles.cameraActions}>
              <TouchableOpacity
                style={styles.backBtn}
                onPress={() => setStage('DRIVING_TO_DROPOFF')}
              >
                <Text style={styles.backBtnText}>← Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.captureBtn, actionLoading && styles.captureBtnDisabled]}
                onPress={handleTakePhoto}
                disabled={actionLoading}
              >
                {actionLoading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <View style={styles.captureInner} />
                )}
              </TouchableOpacity>
              <View style={{ width: 64 }} />
            </View>
          </View>
        </CameraView>
      </SafeAreaView>
    );
  }

  // ── Map + action mode ─────────────────────────────────────────────────────

  const pickupCoord = {
    latitude: order.pickupLocation.coordinates[1],
    longitude: order.pickupLocation.coordinates[0],
  };
  const dropoffCoord = {
    latitude: order.dropoffLocation.coordinates[1],
    longitude: order.dropoffLocation.coordinates[0],
  };

  const stageConf = STAGE_CONFIG[stage];

  return (
    <SafeAreaView style={styles.container}>
      {/* Map */}
      <MapView ref={mapRef} provider={PROVIDER_GOOGLE} style={styles.map} showsUserLocation>
        <Marker coordinate={pickupCoord} title="Pickup" pinColor="#22c55e" />
        <Marker coordinate={dropoffCoord} title="Drop-off" pinColor="#ef4444" />
        <Polyline
          coordinates={[pickupCoord, dropoffCoord]}
          strokeColor="#3b82f6"
          strokeWidth={3}
          lineDashPattern={[8, 4]}
        />
      </MapView>

      {/* Bottom sheet */}
      <View style={styles.sheet}>
        {/* Stage indicator */}
        {stageConf && (
          <View style={styles.stageRow}>
            <View style={[styles.stageDot, { backgroundColor: stageConf.btnColour }]} />
            <Text style={styles.stageLabel}>{stageConf.label}</Text>
          </View>
        )}

        {/* Order number */}
        <Text style={styles.orderNumber}>{order.orderNumber}</Text>

        {/* Route */}
        <View style={styles.routeSection}>
          <View style={styles.routeRow}>
            <View style={[styles.dot, { backgroundColor: '#22c55e' }]} />
            <Text style={styles.routeText} numberOfLines={1}>
              {order.pickupAddress.line1}, {order.pickupAddress.city}
            </Text>
          </View>
          <View style={styles.routeConnector} />
          <View style={styles.routeRow}>
            <View style={[styles.dot, { backgroundColor: '#ef4444' }]} />
            <Text style={styles.routeText} numberOfLines={1}>
              {order.dropoffAddress.line1}, {order.dropoffAddress.city}
            </Text>
          </View>
        </View>

        {/* Recipient */}
        {order.recipientName && (
          <Text style={styles.recipient}>Recipient: {order.recipientName}</Text>
        )}

        {/* Payout */}
        <View style={styles.payoutRow}>
          <Text style={styles.payoutLabel}>Your payout</Text>
          <Text style={styles.payoutValue}>
            {order.currency} {Number(order.driverPayout).toFixed(order.currency === 'BHD' ? 3 : 2)}
          </Text>
        </View>

        {/* Primary action */}
        {stageConf && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: stageConf.btnColour }, actionLoading && styles.actionBtnDisabled]}
            onPress={handlePrimaryAction}
            disabled={actionLoading}
          >
            {actionLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.actionBtnText}>{stageConf.btnLabel}</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  map: { flex: 1 },

  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 32,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
    gap: 10,
  },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stageDot: { width: 10, height: 10, borderRadius: 5 },
  stageLabel: { fontSize: 14, fontWeight: '700', color: '#374151' },
  orderNumber: { fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' },
  routeSection: { gap: 0 },
  routeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  routeConnector: { width: 2, height: 10, backgroundColor: '#e5e7eb', marginLeft: 9 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  routeText: { flex: 1, fontSize: 14, color: '#374151' },
  recipient: { fontSize: 13, color: '#6b7280' },
  payoutRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  payoutLabel: { fontSize: 13, color: '#9ca3af' },
  payoutValue: { fontSize: 18, fontWeight: '800', color: '#111827' },

  actionBtn: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  actionBtnDisabled: { opacity: 0.6 },
  actionBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  // Camera styles
  cameraContainer: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  cameraOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 20,
    paddingTop: 40,
    paddingBottom: 48,
  },
  cameraInstruction: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 12,
    borderRadius: 12,
  },
  cameraFrame: {
    alignSelf: 'center',
    width: Dimensions.get('window').width - 80,
    height: Dimensions.get('window').width - 80,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: 12,
  },
  cameraActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  captureBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#fff',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  captureBtnDisabled: { opacity: 0.5 },
  captureInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#fff',
    borderWidth: 3,
    borderColor: '#d1d5db',
  },
  backBtn: {
    padding: 12,
    width: 64,
    alignItems: 'center',
  },
  backBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});

async function apiPost(path: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${process.env.API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAccessToken()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json() as { success: boolean };
    return data.success;
  } catch {
    Alert.alert('Network error', 'Please check your connection.');
    return false;
  }
}

function getAccessToken(): string {
  return ''; // TODO: from auth context
}
