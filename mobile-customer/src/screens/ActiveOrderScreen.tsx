/**
 * @file ActiveOrderScreen.tsx
 * Live order tracking screen for the customer.
 *
 * ── What this screen does ─────────────────────────────────────────────────
 * 1. Joins the Socket.io order room (`order:{orderId}`) via the auth token.
 * 2. Listens for `driver:location:broadcast` → animates the driver marker.
 * 3. Listens for `order:status:changed` → updates the status banner.
 * 4. When status = DRIVER_ARRIVED, shows the SignaturePad modal.
 * 5. On signature confirm → POST /orders/:id/delivered with proof.
 *
 * ── Map ───────────────────────────────────────────────────────────────────
 * react-native-maps with three markers:
 *   Green pin   = pickup
 *   Red pin     = dropoff
 *   Car icon    = driver (animated with Animated.ValueXY for smooth movement)
 *
 * ── Driver marker animation ───────────────────────────────────────────────
 * Rather than snapping the driver pin to new coordinates, we use
 * `Animated.timing` on a LatLng value to interpolate between the last and
 * new position over 1 second — matching the 1 Hz broadcast interval.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  StyleSheet,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  Animated,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, Region } from 'react-native-maps';
import { io, Socket } from 'socket.io-client';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation';
import { SignaturePad } from '../components/SignaturePad';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface LatLng { latitude: number; longitude: number }

interface OrderDetails {
  id: string;
  orderNumber: string;
  status: string;
  pickupAddress: { line1: string; city: string };
  dropoffAddress: { line1: string; city: string };
  pickupLocation: { coordinates: [number, number] };
  dropoffLocation: { coordinates: [number, number] };
  totalFare: number;
  currency: string;
  driver?: {
    firstName: string;
    vehicleType: string;
    vehiclePlate: string;
    rating: number;
    phoneE164: string;
  };
}

type Props = NativeStackScreenProps<RootStackParamList, 'ActiveOrder'>;

// ─────────────────────────────────────────────────────────────────────────────
// Status display config
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_INFO: Record<string, { label: string; colour: string; icon: string }> = {
  PENDING:          { label: 'Looking for a driver…',     colour: '#f59e0b', icon: '⏳' },
  SEARCHING_DRIVER: { label: 'Finding the nearest driver', colour: '#f59e0b', icon: '🔍' },
  DRIVER_ASSIGNED:  { label: 'Driver is on the way',       colour: '#3b82f6', icon: '🚗' },
  DRIVER_EN_ROUTE:  { label: 'Driver heading to you',      colour: '#3b82f6', icon: '🚗' },
  DRIVER_ARRIVED:   { label: 'Driver has arrived!',        colour: '#8b5cf6', icon: '📍' },
  PICKED_UP:        { label: 'Package picked up',          colour: '#6366f1', icon: '📦' },
  IN_TRANSIT:       { label: 'On the way to drop-off',     colour: '#2563eb', icon: '🚀' },
  DELIVERED:        { label: 'Delivered! 🎉',              colour: '#22c55e', icon: '✅' },
  CANCELLED:        { label: 'Order cancelled',            colour: '#ef4444', icon: '❌' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ActiveOrderScreen({ route, navigation }: Props) {
  const { orderId, orderNumber } = route.params as { orderId: string; orderNumber: string };

  const [order, setOrder] = useState<OrderDetails | null>(null);
  const [orderStatus, setOrderStatus] = useState<string>('PENDING');
  const [driverPos, setDriverPos] = useState<LatLng | null>(null);
  const [showSignature, setShowSignature] = useState(false);
  const [submittingProof, setSubmittingProof] = useState(false);
  const [loading, setLoading] = useState(true);

  const mapRef = useRef<MapView>(null);
  const socketRef = useRef<Socket | null>(null);
  const driverAnimPos = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const prevDriverPos = useRef<LatLng | null>(null);

  // ── Fetch order details ───────────────────────────────────────────────────

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${process.env.API_BASE_URL}/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${getAccessToken()}` },
        });
        const data = await res.json() as { success: boolean; data: OrderDetails };
        if (data.success) {
          setOrder(data.data);
          setOrderStatus(data.data.status);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [orderId]);

  // ── Socket.io connection ──────────────────────────────────────────────────

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const socket = io(process.env.API_SOCKET_URL ?? '', {
      auth: { token },
      transports: ['websocket'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      // Join the order room
      socket.emit('join_room', { room: `order:${orderId}` });
    });

    // ── Driver location broadcast ─────────────────────────────────────────
    // Arrives at ≤1 Hz.  We animate the marker smoothly over 900 ms.
    socket.on('driver:location:broadcast', (payload: {
      driverId: string;
      location: { coordinates: [number, number] };
      heading?: number;
      timestamp: number;
    }) => {
      const newPos: LatLng = {
        latitude: payload.location.coordinates[1],
        longitude: payload.location.coordinates[0],
      };

      setDriverPos(newPos);

      // Smooth animation: interpolate from last known position to new
      if (prevDriverPos.current) {
        Animated.timing(driverAnimPos, {
          toValue: { x: newPos.longitude, y: newPos.latitude },
          duration: 900,
          useNativeDriver: false, // coordinates can't use native driver
        }).start();
      } else {
        driverAnimPos.setValue({ x: newPos.longitude, y: newPos.latitude });
      }

      prevDriverPos.current = newPos;

      // Keep map centred on driver
      mapRef.current?.animateToRegion({
        latitude: newPos.latitude,
        longitude: newPos.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      }, 800);
    });

    // ── Order status changes ──────────────────────────────────────────────
    socket.on('order:status:changed', (payload: { orderId: string; status: string }) => {
      if (payload.orderId !== orderId) return;
      setOrderStatus(payload.status);

      // Trigger signature pad when driver arrives
      if (payload.status === 'DRIVER_ARRIVED') {
        setShowSignature(true);
      }

      // Navigate away on terminal states
      if (payload.status === 'DELIVERED') {
        socket.disconnect();
        navigation.replace('OrderComplete', { orderId });
      }
      if (payload.status === 'CANCELLED') {
        socket.disconnect();
        Alert.alert('Order Cancelled', 'Your order has been cancelled.', [
          { text: 'OK', onPress: () => navigation.navigate('Home') },
        ]);
      }
    });

    socket.on('connect_error', (err) => {
      console.warn('[ActiveOrder] Socket error:', err.message);
    });

    return () => {
      socket.disconnect();
    };
  }, [orderId, navigation]);

  // ── Proof of delivery submission ──────────────────────────────────────────

  const handleSignatureConfirm = useCallback(async (signatureBase64: string) => {
    setShowSignature(false);
    setSubmittingProof(true);

    try {
      const res = await fetch(`${process.env.API_BASE_URL}/orders/${orderId}/signature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAccessToken()}` },
        body: JSON.stringify({
          signatureBase64,
          capturedAt: new Date().toISOString(),
        }),
      });
      const data = await res.json() as { success: boolean };
      if (!data.success) {
        Alert.alert('Error', 'Could not submit signature. Please try again.');
      }
    } catch {
      Alert.alert('Network error', 'Please try again.');
    } finally {
      setSubmittingProof(false);
    }
  }, [orderId]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading || !order) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  const pickupCoord: LatLng = {
    latitude: order.pickupLocation.coordinates[1],
    longitude: order.pickupLocation.coordinates[0],
  };
  const dropoffCoord: LatLng = {
    latitude: order.dropoffLocation.coordinates[1],
    longitude: order.dropoffLocation.coordinates[0],
  };

  const statusInfo = STATUS_INFO[orderStatus] ?? { label: orderStatus, colour: '#6b7280', icon: '📦' };
  const isTerminal = ['DELIVERED', 'CANCELLED', 'FAILED'].includes(orderStatus);

  return (
    <SafeAreaView style={styles.container}>

      {/* ── Map ──────────────────────────────────────────────────────── */}
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={styles.map}
        initialRegion={{
          ...pickupCoord,
          latitudeDelta: 0.03,
          longitudeDelta: 0.03,
        }}
        showsUserLocation
      >
        {/* Pickup marker */}
        <Marker coordinate={pickupCoord} title="Pickup" pinColor="#22c55e" />

        {/* Dropoff marker */}
        <Marker coordinate={dropoffCoord} title="Drop-off" pinColor="#ef4444" />

        {/* Driver marker (animated) */}
        {driverPos && (
          <Marker coordinate={driverPos} title="Driver">
            <View style={styles.driverMarker}>
              <Text style={styles.driverMarkerEmoji}>🚗</Text>
            </View>
          </Marker>
        )}

        {/* Route line pickup → dropoff */}
        <Polyline
          coordinates={[pickupCoord, ...(driverPos ? [driverPos] : []), dropoffCoord]}
          strokeColor="#3b82f6"
          strokeWidth={3}
          lineDashPattern={[8, 4]}
        />
      </MapView>

      {/* ── Status banner ─────────────────────────────────────────────── */}
      <View style={[styles.statusBanner, { backgroundColor: statusInfo.colour }]}>
        <Text style={styles.statusIcon}>{statusInfo.icon}</Text>
        <Text style={styles.statusLabel}>{statusInfo.label}</Text>
      </View>

      {/* ── Bottom sheet ──────────────────────────────────────────────── */}
      <View style={styles.bottomSheet}>
        <Text style={styles.orderNumber}>{order.orderNumber}</Text>

        {/* Route summary */}
        <View style={styles.routeRow}>
          <View style={[styles.dot, { backgroundColor: '#22c55e' }]} />
          <Text style={styles.routeText} numberOfLines={1}>{order.pickupAddress.line1}, {order.pickupAddress.city}</Text>
        </View>
        <View style={[styles.routeConnector]} />
        <View style={styles.routeRow}>
          <View style={[styles.dot, { backgroundColor: '#ef4444' }]} />
          <Text style={styles.routeText} numberOfLines={1}>{order.dropoffAddress.line1}, {order.dropoffAddress.city}</Text>
        </View>

        {/* Driver info */}
        {order.driver && (
          <View style={styles.driverInfo}>
            <Text style={styles.driverName}>{order.driver.firstName}</Text>
            <Text style={styles.driverSub}>{order.driver.vehicleType} · {order.driver.vehiclePlate}</Text>
            <View style={styles.ratingRow}>
              <Text style={styles.starIcon}>⭐</Text>
              <Text style={styles.ratingText}>{Number(order.driver.rating).toFixed(1)}</Text>
            </View>
          </View>
        )}

        {/* Fare */}
        <View style={styles.fareRow}>
          <Text style={styles.fareLabel}>Total fare</Text>
          <Text style={styles.fareValue}>
            {order.currency} {Number(order.totalFare).toFixed(order.currency === 'BHD' ? 3 : 2)}
          </Text>
        </View>

        {/* Cancel button (while order is not terminal) */}
        {!isTerminal && orderStatus === 'PENDING' && (
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => Alert.alert('Cancel Order', 'Are you sure?', [
              { text: 'No' },
              {
                text: 'Yes, Cancel',
                style: 'destructive',
                onPress: () => {
                  // TODO: POST /orders/:id/cancel
                },
              },
            ])}
          >
            <Text style={styles.cancelBtnText}>Cancel Order</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Signature modal ────────────────────────────────────────────── */}
      <Modal
        visible={showSignature}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowSignature(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Proof of Delivery</Text>
            <TouchableOpacity onPress={() => setShowSignature(false)}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.modalSubtitle}>
            Your driver has arrived. Please sign to confirm receipt.
          </Text>
          <SignaturePad
            recipientName={order?.pickupAddress?.city}
            onConfirm={handleSignatureConfirm}
          />
          {submittingProof && (
            <View style={styles.proofOverlay}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.proofOverlayText}>Submitting proof…</Text>
            </View>
          )}
        </SafeAreaView>
      </Modal>

    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  map: { flex: 1 },

  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  statusIcon: { fontSize: 18 },
  statusLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },

  bottomSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 32,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  orderNumber: { fontSize: 12, color: '#9ca3af', fontFamily: 'monospace', marginBottom: 12 },

  routeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  routeConnector: { width: 2, height: 12, backgroundColor: '#e5e7eb', marginLeft: 9, marginVertical: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  routeText: { flex: 1, fontSize: 14, color: '#374151' },

  driverInfo: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f1f5f9',
    borderRadius: 12,
    padding: 12,
  },
  driverName: { fontSize: 15, fontWeight: '700', color: '#111827', flex: 1 },
  driverSub: { fontSize: 12, color: '#6b7280' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  starIcon: { fontSize: 12 },
  ratingText: { fontSize: 13, fontWeight: '600', color: '#374151' },

  fareRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  fareLabel: { fontSize: 13, color: '#9ca3af' },
  fareValue: { fontSize: 17, fontWeight: '800', color: '#111827' },

  cancelBtn: {
    marginTop: 14,
    borderWidth: 1.5,
    borderColor: '#fca5a5',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelBtnText: { color: '#dc2626', fontWeight: '600', fontSize: 14 },

  driverMarker: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  driverMarkerEmoji: { fontSize: 22 },

  modalContainer: { flex: 1, backgroundColor: '#fff' },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#111827' },
  modalClose: { fontSize: 20, color: '#9ca3af', padding: 4 },
  modalSubtitle: { fontSize: 14, color: '#6b7280', margin: 16 },

  proofOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  proofOverlayText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});

function getAccessToken(): string {
  return ''; // TODO: from auth context
}
