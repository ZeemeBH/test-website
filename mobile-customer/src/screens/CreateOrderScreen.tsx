/**
 * @file CreateOrderScreen.tsx
 * Customer booking flow — pick up address, drop-off address,
 * item description, and upfront price estimate.
 *
 * ── UX flow ────────────────────────────────────────────────────────────────
 * 1. Customer taps "Pickup" address field → opens autocomplete / map pin picker.
 * 2. Customer taps "Drop-off" field → same.
 * 3. Both addresses filled → GET /orders/estimate returns fare breakdown.
 * 4. Customer selects vehicle type, payment method, adds notes.
 * 5. Taps "Book Now" → POST /orders → navigate to ActiveOrderScreen.
 *
 * ── Currency display ───────────────────────────────────────────────────────
 * The user's preferred currency is read from their profile (stored in
 * AsyncStorage after login).  BHD is displayed with 3 decimal places,
 * SAR/AED/USD with 2.
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AddressInput {
  line1: string;
  city: string;
  countryCode: string;
  /** Coordinates from map-tap or geocoder */
  coordinates?: { lat: number; lng: number };
}

interface FareEstimate {
  currency: string;
  decimalPlaces: number;
  baseFare: number;
  distanceFare: number;
  surcharge: number;
  discount: number;
  totalFare: number;
  estimatedDistanceKm: number;
  estimatedDurationMin: number;
}

type VehicleType = 'MOTORCYCLE' | 'CAR' | 'VAN' | 'PICKUP_TRUCK';
type PaymentMethod = 'CASH' | 'CARD' | 'WALLET';
type Currency = 'BHD' | 'SAR' | 'AED' | 'USD';

const VEHICLE_LABELS: Record<VehicleType, string> = {
  MOTORCYCLE: '🏍️  Moto',
  CAR:        '🚗  Car',
  VAN:        '🚐  Van',
  PICKUP_TRUCK:'🚛  Pickup',
};

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  CASH:   '💵  Cash',
  CARD:   '💳  Card',
  WALLET: '📱  Wallet',
};

type Props = NativeStackScreenProps<RootStackParamList, 'CreateOrder'>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatFare(amount: number, currency: Currency): string {
  const dp = currency === 'BHD' ? 3 : 2;
  return `${currency} ${amount.toFixed(dp)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function CreateOrderScreen({ navigation }: Props) {
  // Form state
  const [pickup, setPickup] = useState<AddressInput>({ line1: '', city: '', countryCode: 'BH' });
  const [dropoff, setDropoff] = useState<AddressInput>({ line1: '', city: '', countryCode: 'BH' });
  const [itemDescription, setItemDescription] = useState('');
  const [vehicleType, setVehicleType] = useState<VehicleType>('MOTORCYCLE');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [currency] = useState<Currency>('BHD'); // from user profile in real app

  // Estimate state
  const [estimate, setEstimate] = useState<FareEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  // Submission state
  const [submitting, setSubmitting] = useState(false);

  const estimateDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch fare estimate ───────────────────────────────────────────────────

  const fetchEstimate = useCallback(async () => {
    if (!pickup.coordinates || !dropoff.coordinates) return;

    setEstimating(true);
    try {
      const res = await fetch(`${process.env.API_BASE_URL}/orders/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAccessToken()}` },
        body: JSON.stringify({
          pickupLocation: { type: 'Point', coordinates: [pickup.coordinates.lng, pickup.coordinates.lat] },
          dropoffLocation: { type: 'Point', coordinates: [dropoff.coordinates.lng, dropoff.coordinates.lat] },
          currency,
          vehicleType,
        }),
      });
      const data = await res.json() as { success: boolean; data: FareEstimate };
      if (data.success) setEstimate(data.data);
    } catch {
      // Silently fail estimate — user can still book
    } finally {
      setEstimating(false);
    }
  }, [pickup.coordinates, dropoff.coordinates, currency, vehicleType]);

  // Re-fetch estimate when vehicle type changes
  const onVehicleChange = useCallback((v: VehicleType) => {
    setVehicleType(v);
    if (estimateDebounce.current) clearTimeout(estimateDebounce.current);
    estimateDebounce.current = setTimeout(fetchEstimate, 400);
  }, [fetchEstimate]);

  // ── Submit order ──────────────────────────────────────────────────────────

  const handleBookNow = useCallback(async () => {
    if (!pickup.coordinates || !dropoff.coordinates) {
      Alert.alert('Missing address', 'Please set both pickup and drop-off locations.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${process.env.API_BASE_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAccessToken()}` },
        body: JSON.stringify({
          pickupAddress: { line1: pickup.line1, city: pickup.city, countryCode: pickup.countryCode },
          pickupLocation: { type: 'Point', coordinates: [pickup.coordinates.lng, pickup.coordinates.lat] },
          dropoffAddress: { line1: dropoff.line1, city: dropoff.city, countryCode: dropoff.countryCode },
          dropoffLocation: { type: 'Point', coordinates: [dropoff.coordinates.lng, dropoff.coordinates.lat] },
          packageDetails: { description: itemDescription },
          vehicleType,
          currency,
          paymentMethod,
        }),
      });

      const data = await res.json() as { success: boolean; data: { id: string; orderNumber: string } };

      if (!data.success) {
        Alert.alert('Booking failed', 'Please try again.');
        return;
      }

      navigation.replace('ActiveOrder', { orderId: data.data.id, orderNumber: data.data.orderNumber });
    } catch {
      Alert.alert('Network error', 'Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }, [pickup, dropoff, itemDescription, vehicleType, currency, paymentMethod, navigation]);

  // ── Render ────────────────────────────────────────────────────────────────

  const canBook = !!pickup.coordinates && !!dropoff.coordinates && !submitting;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

        <Text style={styles.title}>Book a Pickup</Text>

        {/* ── Pickup address ─────────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.label}>Pickup Location</Text>
          <View style={styles.addressRow}>
            <View style={[styles.dot, { backgroundColor: '#22c55e' }]} />
            <TextInput
              style={styles.addressInput}
              placeholder="Street address, building"
              value={pickup.line1}
              onChangeText={(t) => setPickup((p) => ({ ...p, line1: t }))}
              placeholderTextColor="#9ca3af"
            />
          </View>
          <TextInput
            style={[styles.addressInput, { marginLeft: 28, marginTop: 4 }]}
            placeholder="City"
            value={pickup.city}
            onChangeText={(t) => setPickup((p) => ({ ...p, city: t }))}
            placeholderTextColor="#9ca3af"
          />
          {/* In a real app, this opens the map picker and populates coordinates */}
          <TouchableOpacity
            style={styles.mapPickerBtn}
            onPress={() => {
              // TODO: navigate to MapPicker screen and return coordinates
              // Stub: use Manama coordinates for demo
              setPickup((p) => ({ ...p, coordinates: { lat: 26.215, lng: 50.586 } }));
              fetchEstimate();
            }}
          >
            <Text style={styles.mapPickerText}>📍 Pin on map</Text>
          </TouchableOpacity>
        </View>

        {/* ── Drop-off address ───────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.label}>Drop-off Location</Text>
          <View style={styles.addressRow}>
            <View style={[styles.dot, { backgroundColor: '#ef4444' }]} />
            <TextInput
              style={styles.addressInput}
              placeholder="Street address, building"
              value={dropoff.line1}
              onChangeText={(t) => setDropoff((p) => ({ ...p, line1: t }))}
              placeholderTextColor="#9ca3af"
            />
          </View>
          <TextInput
            style={[styles.addressInput, { marginLeft: 28, marginTop: 4 }]}
            placeholder="City"
            value={dropoff.city}
            onChangeText={(t) => setDropoff((p) => ({ ...p, city: t }))}
            placeholderTextColor="#9ca3af"
          />
          <TouchableOpacity
            style={styles.mapPickerBtn}
            onPress={() => {
              setDropoff((p) => ({ ...p, coordinates: { lat: 26.240, lng: 50.610 } }));
              fetchEstimate();
            }}
          >
            <Text style={styles.mapPickerText}>📍 Pin on map</Text>
          </TouchableOpacity>
        </View>

        {/* ── Item description ───────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.label}>Item Description</Text>
          <TextInput
            style={[styles.addressInput, { minHeight: 72, textAlignVertical: 'top' }]}
            placeholder="e.g. Documents, phone charger, laundry bag…"
            value={itemDescription}
            onChangeText={setItemDescription}
            multiline
            numberOfLines={3}
            placeholderTextColor="#9ca3af"
          />
        </View>

        {/* ── Vehicle type ───────────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.label}>Vehicle Type</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {(Object.keys(VEHICLE_LABELS) as VehicleType[]).map((v) => (
              <TouchableOpacity
                key={v}
                style={[styles.chip, vehicleType === v && styles.chipSelected]}
                onPress={() => onVehicleChange(v)}
              >
                <Text style={[styles.chipText, vehicleType === v && styles.chipTextSelected]}>
                  {VEHICLE_LABELS[v]}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* ── Payment method ─────────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.label}>Payment Method</Text>
          <View style={styles.paymentRow}>
            {(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map((p) => (
              <TouchableOpacity
                key={p}
                style={[styles.paymentChip, paymentMethod === p && styles.chipSelected]}
                onPress={() => setPaymentMethod(p)}
              >
                <Text style={[styles.chipText, paymentMethod === p && styles.chipTextSelected]}>
                  {PAYMENT_LABELS[p]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── Fare estimate panel ────────────────────────────────────── */}
        {(estimating || estimate) && (
          <View style={[styles.card, styles.estimateCard]}>
            {estimating ? (
              <View style={styles.estimateLoading}>
                <ActivityIndicator size="small" color="#3b82f6" />
                <Text style={styles.estimateLoadingText}>Calculating fare…</Text>
              </View>
            ) : estimate ? (
              <>
                <Text style={styles.estimateTitle}>Fare Estimate</Text>
                <View style={styles.estimateRow}>
                  <Text style={styles.estimateKey}>Distance</Text>
                  <Text style={styles.estimateVal}>{estimate.estimatedDistanceKm.toFixed(1)} km</Text>
                </View>
                <View style={styles.estimateRow}>
                  <Text style={styles.estimateKey}>Est. time</Text>
                  <Text style={styles.estimateVal}>{estimate.estimatedDurationMin} min</Text>
                </View>
                <View style={styles.estimateRow}>
                  <Text style={styles.estimateKey}>Base fare</Text>
                  <Text style={styles.estimateVal}>{formatFare(estimate.baseFare, currency)}</Text>
                </View>
                {estimate.surcharge > 0 && (
                  <View style={styles.estimateRow}>
                    <Text style={styles.estimateKey}>Surcharge</Text>
                    <Text style={styles.estimateVal}>{formatFare(estimate.surcharge, currency)}</Text>
                  </View>
                )}
                <View style={[styles.estimateRow, styles.estimateTotalRow]}>
                  <Text style={styles.estimateTotalKey}>Total</Text>
                  <Text style={styles.estimateTotalVal}>{formatFare(estimate.totalFare, currency)}</Text>
                </View>
              </>
            ) : null}
          </View>
        )}

        {/* ── Book button ────────────────────────────────────────────── */}
        <TouchableOpacity
          style={[styles.bookBtn, !canBook && styles.bookBtnDisabled]}
          onPress={handleBookNow}
          disabled={!canBook}
          activeOpacity={0.85}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.bookBtnText}>
              {estimate ? `Book Now · ${formatFare(estimate.totalFare, currency)}` : 'Book Now'}
            </Text>
          )}
        </TouchableOpacity>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  scroll: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 16 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  label: { fontSize: 12, fontWeight: '600', color: '#6b7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  addressInput: {
    flex: 1,
    fontSize: 15,
    color: '#111827',
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  mapPickerBtn: { marginTop: 8, alignSelf: 'flex-start' },
  mapPickerText: { fontSize: 13, color: '#3b82f6', fontWeight: '600' },

  chipRow: { flexDirection: 'row' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    marginRight: 8,
    backgroundColor: '#f9fafb',
  },
  chipSelected: { borderColor: '#3b82f6', backgroundColor: '#eff6ff' },
  chipText: { fontSize: 13, color: '#6b7280', fontWeight: '500' },
  chipTextSelected: { color: '#2563eb', fontWeight: '700' },

  paymentRow: { flexDirection: 'row', gap: 8 },
  paymentChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
  },

  estimateCard: { backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#bfdbfe' },
  estimateLoading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  estimateLoadingText: { fontSize: 14, color: '#3b82f6' },
  estimateTitle: { fontSize: 13, fontWeight: '700', color: '#1d4ed8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  estimateRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  estimateKey: { fontSize: 13, color: '#6b7280' },
  estimateVal: { fontSize: 13, color: '#374151', fontWeight: '500' },
  estimateTotalRow: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#bfdbfe' },
  estimateTotalKey: { fontSize: 15, fontWeight: '700', color: '#1e40af' },
  estimateTotalVal: { fontSize: 17, fontWeight: '800', color: '#1e40af' },

  bookBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: '#2563eb',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  bookBtnDisabled: { backgroundColor: '#93c5fd', shadowOpacity: 0 },
  bookBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

// ─────────────────────────────────────────────────────────────────────────────
// Stub — replace with actual token retrieval from AsyncStorage or auth context
// ─────────────────────────────────────────────────────────────────────────────

function getAccessToken(): string {
  return ''; // TODO: return from auth context
}
