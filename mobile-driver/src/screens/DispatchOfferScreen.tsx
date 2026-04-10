/**
 * @file DispatchOfferScreen.tsx
 * 15-second countdown dispatch offer screen.
 *
 * Triggered when the driver's Socket.io connection receives a
 * `order:new:request` event from the DispatchEngine.
 *
 * ── Countdown logic ────────────────────────────────────────────────────────
 * The server sets `DISPATCH_DRIVER_RESPONSE_TIMEOUT_MS` (default 30 s).
 * We mirror this locally as a visual countdown.  If the timer hits zero
 * before the driver responds, we auto-emit a `driver:order:reject` to free
 * the dispatch loop.
 *
 * The socket is passed via route params to allow direct emit from this screen
 * without re-connecting.  In a production app, the socket would live in a
 * React Context or Zustand store.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Animated,
  Vibration,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DriverStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<DriverStackParamList, 'DispatchOffer'>;

interface NewOrderOffer {
  orderId: string;
  orderNumber: string;
  pickupAddress: { line1: string; city: string };
  dropoffAddress: { line1: string; city: string };
  distanceKm: number;
  estimatedFare: number;
  currency: string;
  timeoutSec: number;
}

export function DispatchOfferScreen({ route, navigation }: Props) {
  const { offer } = route.params as { offer: NewOrderOffer };
  const [secondsLeft, setSecondsLeft] = useState(offer.timeoutSec);
  const [responding, setResponding] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressAnim = useRef(new Animated.Value(1)).current;

  // ── Vibrate on arrival ────────────────────────────────────────────────────

  useEffect(() => {
    Vibration.vibrate([0, 400, 200, 400]);
  }, []);

  // ── Countdown ─────────────────────────────────────────────────────────────

  useEffect(() => {
    // Animate progress bar from 1 → 0 over timeoutSec
    Animated.timing(progressAnim, {
      toValue: 0,
      duration: offer.timeoutSec * 1_000,
      useNativeDriver: false,
    }).start();

    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current!);
          handleTimeout();
          return 0;
        }
        return s - 1;
      });
    }, 1_000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ── Timeout (auto-reject) ─────────────────────────────────────────────────

  const handleTimeout = useCallback(() => {
    emitReject();
    navigation.replace('Dashboard');
  }, [navigation]);

  // ── Accept ────────────────────────────────────────────────────────────────

  const handleAccept = useCallback(() => {
    if (responding) return;
    setResponding(true);
    if (timerRef.current) clearInterval(timerRef.current);

    emitAccept(offer.orderId);
    navigation.replace('ActiveJob', { orderId: offer.orderId });
  }, [offer.orderId, navigation, responding]);

  // ── Decline ───────────────────────────────────────────────────────────────

  const handleDecline = useCallback(() => {
    if (responding) return;
    setResponding(true);
    if (timerRef.current) clearInterval(timerRef.current);

    emitReject();
    navigation.replace('Dashboard');
  }, [navigation, responding]);

  // ── Progress colour (green → yellow → red as time runs out) ──────────────

  const progressColour = progressAnim.interpolate({
    inputRange: [0, 0.33, 0.66, 1],
    outputRange: ['#ef4444', '#f59e0b', '#f59e0b', '#22c55e'],
  });

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>

        {/* Countdown ring */}
        <View style={styles.countdownWrap}>
          <Text style={styles.countdownNumber}>{secondsLeft}</Text>
          <Text style={styles.countdownLabel}>seconds</Text>
        </View>

        {/* Progress bar */}
        <View style={styles.progressTrack}>
          <Animated.View
            style={[
              styles.progressBar,
              {
                width: progressAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', '100%'],
                }),
                backgroundColor: progressColour,
              },
            ]}
          />
        </View>

        <Text style={styles.title}>New Order Request</Text>
        <Text style={styles.orderNum}>{offer.orderNumber}</Text>

        {/* Route */}
        <View style={styles.routeCard}>
          <View style={styles.routeRow}>
            <View style={[styles.dot, { backgroundColor: '#22c55e' }]} />
            <Text style={styles.routeText} numberOfLines={2}>
              {offer.pickupAddress.line1}{'\n'}{offer.pickupAddress.city}
            </Text>
          </View>
          <View style={styles.routeConnector} />
          <View style={styles.routeRow}>
            <View style={[styles.dot, { backgroundColor: '#ef4444' }]} />
            <Text style={styles.routeText} numberOfLines={2}>
              {offer.dropoffAddress.line1}{'\n'}{offer.dropoffAddress.city}
            </Text>
          </View>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statVal}>{offer.distanceKm.toFixed(1)} km</Text>
            <Text style={styles.statLbl}>Distance</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statVal, { color: '#22c55e' }]}>
              {offer.currency} {Number(offer.estimatedFare).toFixed(offer.currency === 'BHD' ? 3 : 2)}
            </Text>
            <Text style={styles.statLbl}>Your payout</Text>
          </View>
        </View>

        {/* Buttons */}
        <View style={styles.btnRow}>
          <TouchableOpacity
            style={[styles.declineBtn, responding && styles.btnDisabled]}
            onPress={handleDecline}
            disabled={responding}
          >
            <Text style={styles.declineBtnText}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.acceptBtn, responding && styles.btnDisabled]}
            onPress={handleAccept}
            disabled={responding}
          >
            <Text style={styles.acceptBtnText}>Accept</Text>
          </TouchableOpacity>
        </View>

      </View>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 28,
    padding: 24,
    gap: 14,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  countdownWrap: { alignItems: 'center', marginBottom: 4 },
  countdownNumber: { fontSize: 52, fontWeight: '900', color: '#111827', lineHeight: 56 },
  countdownLabel: { fontSize: 12, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1 },

  progressTrack: { height: 6, backgroundColor: '#f3f4f6', borderRadius: 3, overflow: 'hidden' },
  progressBar: { height: 6, borderRadius: 3 },

  title: { fontSize: 20, fontWeight: '800', color: '#111827', textAlign: 'center' },
  orderNum: { fontSize: 12, color: '#9ca3af', textAlign: 'center', fontFamily: 'monospace' },

  routeCard: {
    backgroundColor: '#f9fafb',
    borderRadius: 14,
    padding: 14,
    gap: 0,
  },
  routeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  routeConnector: { width: 2, height: 16, backgroundColor: '#e5e7eb', marginLeft: 9 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 3 },
  routeText: { flex: 1, fontSize: 13, color: '#374151', lineHeight: 18 },

  statsRow: {
    flexDirection: 'row',
    backgroundColor: '#f0fdf4',
    borderRadius: 14,
    padding: 14,
    gap: 0,
  },
  statItem: { flex: 1, alignItems: 'center' },
  statVal: { fontSize: 17, fontWeight: '800', color: '#111827' },
  statLbl: { fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginTop: 2 },
  statDivider: { width: 1, backgroundColor: '#d1fae5' },

  btnRow: { flexDirection: 'row', gap: 12 },
  declineBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#fca5a5',
    alignItems: 'center',
  },
  declineBtnText: { color: '#dc2626', fontSize: 16, fontWeight: '700' },
  acceptBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#22c55e',
    alignItems: 'center',
    shadowColor: '#22c55e',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  acceptBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Socket emit helpers (access shared socket from context in production)
// ─────────────────────────────────────────────────────────────────────────────

import { io } from 'socket.io-client';

function emitAccept(orderId: string): void {
  // In production, use the socket from SocketContext
  const socket = (global as { __driverSocket?: ReturnType<typeof io> }).__driverSocket;
  socket?.emit('driver:order:accept', { orderId });
}

function emitReject(): void {
  const socket = (global as { __driverSocket?: ReturnType<typeof io> }).__driverSocket;
  socket?.emit('driver:order:reject', {});
}
