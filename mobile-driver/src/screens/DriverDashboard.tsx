/**
 * @file DriverDashboard.tsx
 * Driver home screen — "Go Online" toggle and earnings summary.
 *
 * ── State machine ─────────────────────────────────────────────────────────
 *
 *   OFFLINE  ──(toggle ON)──►  GOING_ONLINE  ──(permissions + socket)──►  ONLINE
 *   ONLINE   ──(toggle OFF)──► GOING_OFFLINE ──(stop LocationService)──►  OFFLINE
 *
 * ── What happens on "Go Online" ───────────────────────────────────────────
 * 1. Request foreground + background location permissions.
 * 2. Connect Socket.io (auth.token handshake).
 * 3. Emit `driver:go_online` with current GPS position.
 * 4. Start LocationService — begins emitting `location_ping` every 3-5 s.
 * 5. Register `dispatch:new_order` listener → navigate to DispatchOfferScreen.
 *
 * ── What happens on "Go Offline" ──────────────────────────────────────────
 * 1. Emit `driver:go_offline`.
 * 2. Stop LocationService (stops background GPS).
 * 3. Disconnect Socket.io.
 * 4. Update DB via PATCH /drivers/me/status.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Switch,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { io, Socket } from 'socket.io-client';
import * as Location from 'expo-location';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DriverStackParamList } from '../types/navigation';
import { LocationService } from '../services/LocationService';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type OnlineStatus = 'OFFLINE' | 'GOING_ONLINE' | 'ONLINE' | 'GOING_OFFLINE';

interface DriverStats {
  todayDeliveries: number;
  todayEarnings: number;
  currency: string;
  rating: number;
  totalDeliveries: number;
}

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

type Props = NativeStackScreenProps<DriverStackParamList, 'Dashboard'>;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function DriverDashboard({ navigation }: Props) {
  const [onlineStatus, setOnlineStatus] = useState<OnlineStatus>('OFFLINE');
  const [stats, setStats] = useState<DriverStats | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const locationServiceRef = useRef<LocationService | null>(null);

  // ── Fetch stats ───────────────────────────────────────────────────────────

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${process.env.API_BASE_URL}/drivers/me/stats`, {
          headers: { Authorization: `Bearer ${getAccessToken()}` },
        });
        const data = await res.json() as { success: boolean; data: DriverStats };
        if (data.success) setStats(data.data);
      } catch { /* non-fatal */ }
    })();
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      void locationServiceRef.current?.stop();
      socketRef.current?.disconnect();
    };
  }, []);

  // ── Go Online ─────────────────────────────────────────────────────────────

  const goOnline = useCallback(async () => {
    setOnlineStatus('GOING_ONLINE');

    try {
      // 1. Get current position for initial go_online emit
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Location Required',
          'Please enable location access in Settings to go online.',
        );
        setOnlineStatus('OFFLINE');
        return;
      }

      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });

      // 2. Connect Socket.io
      const socket = io(process.env.API_SOCKET_URL ?? '', {
        auth: { token: getAccessToken() },
        transports: ['websocket'],
        reconnectionAttempts: 5,
      });

      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
        setTimeout(reject, 10_000); // 10 s connection timeout
      });

      socketRef.current = socket;

      // 3. Tell server we're online
      socket.emit('driver:go_online', {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });

      // 4. Start background location pings
      const locationSvc = new LocationService(socket);
      await locationSvc.start();
      locationServiceRef.current = locationSvc;

      // 5. Listen for new order dispatch offers
      socket.on('order:new:request', (offer: NewOrderOffer) => {
        navigation.navigate('DispatchOffer', { offer });
      });

      socket.on('disconnect', () => {
        // Server dropped us — mark offline
        setOnlineStatus('OFFLINE');
      });

      setOnlineStatus('ONLINE');
    } catch (err) {
      Alert.alert('Failed to go online', 'Please check your connection and try again.');
      setOnlineStatus('OFFLINE');
      socketRef.current?.disconnect();
      socketRef.current = null;
    }
  }, [navigation]);

  // ── Go Offline ────────────────────────────────────────────────────────────

  const goOffline = useCallback(async () => {
    setOnlineStatus('GOING_OFFLINE');

    try {
      socketRef.current?.emit('driver:go_offline');
      await locationServiceRef.current?.stop();
      socketRef.current?.disconnect();
    } finally {
      socketRef.current = null;
      locationServiceRef.current = null;
      setOnlineStatus('OFFLINE');
    }
  }, []);

  // ── Toggle handler ────────────────────────────────────────────────────────

  const handleToggle = useCallback(async (value: boolean) => {
    if (value) {
      await goOnline();
    } else {
      Alert.alert('Go Offline?', 'You won\'t receive new orders.', [
        { text: 'Stay Online' },
        { text: 'Go Offline', style: 'destructive', onPress: goOffline },
      ]);
    }
  }, [goOnline, goOffline]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isOnline = onlineStatus === 'ONLINE';
  const isTransitioning = onlineStatus === 'GOING_ONLINE' || onlineStatus === 'GOING_OFFLINE';

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>

        {/* ── Header ────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Driver Dashboard</Text>
          <TouchableOpacity
            onPress={() => navigation.navigate('Profile')}
            style={styles.profileBtn}
          >
            <Text style={styles.profileIcon}>👤</Text>
          </TouchableOpacity>
        </View>

        {/* ── Online toggle ─────────────────────────────────────────── */}
        <View style={[styles.toggleCard, isOnline ? styles.toggleCardOnline : styles.toggleCardOffline]}>
          <View>
            <Text style={styles.toggleTitle}>
              {isTransitioning ? (onlineStatus === 'GOING_ONLINE' ? 'Going Online…' : 'Going Offline…') :
               isOnline ? 'You are Online' : 'You are Offline'}
            </Text>
            <Text style={styles.toggleSubtitle}>
              {isOnline
                ? 'Receiving new orders'
                : 'Toggle to start receiving orders'}
            </Text>
          </View>

          {isTransitioning ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Switch
              value={isOnline}
              onValueChange={handleToggle}
              trackColor={{ false: 'rgba(255,255,255,0.3)', true: '#4ade80' }}
              thumbColor="#fff"
              ios_backgroundColor="rgba(255,255,255,0.3)"
            />
          )}
        </View>

        {/* ── Today's stats ─────────────────────────────────────────── */}
        {stats && (
          <>
            <Text style={styles.sectionTitle}>Today</Text>
            <View style={styles.statsRow}>
              <View style={styles.statCard}>
                <Text style={styles.statValue}>{stats.todayDeliveries}</Text>
                <Text style={styles.statLabel}>Deliveries</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statValue}>
                  {stats.currency} {stats.todayEarnings.toFixed(stats.currency === 'BHD' ? 3 : 2)}
                </Text>
                <Text style={styles.statLabel}>Earned</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statValue}>⭐ {Number(stats.rating).toFixed(1)}</Text>
                <Text style={styles.statLabel}>Rating</Text>
              </View>
            </View>

            {/* Total deliveries */}
            <View style={styles.totalCard}>
              <Text style={styles.totalLabel}>Total deliveries completed</Text>
              <Text style={styles.totalValue}>{stats.totalDeliveries}</Text>
            </View>
          </>
        )}

        {/* ── Online instructions ───────────────────────────────────── */}
        {isOnline && (
          <View style={styles.onlineHint}>
            <Text style={styles.onlineHintIcon}>📡</Text>
            <Text style={styles.onlineHintText}>
              Your location is being shared every few seconds. Orders will appear automatically when dispatched to you.
            </Text>
          </View>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  scroll: { padding: 16, gap: 12 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#111827' },
  profileBtn: { padding: 8 },
  profileIcon: { fontSize: 22 },

  toggleCard: {
    borderRadius: 20,
    padding: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  toggleCardOnline: {
    backgroundColor: '#2563eb',
    shadowColor: '#2563eb',
  },
  toggleCardOffline: {
    backgroundColor: '#374151',
    shadowColor: '#000',
  },
  toggleTitle: { fontSize: 18, fontWeight: '800', color: '#fff', marginBottom: 4 },
  toggleSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.75)' },

  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },

  statsRow: { flexDirection: 'row', gap: 10 },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  statValue: { fontSize: 16, fontWeight: '800', color: '#111827', marginBottom: 4 },
  statLabel: { fontSize: 11, color: '#9ca3af', fontWeight: '600', textTransform: 'uppercase' },

  totalCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  totalLabel: { fontSize: 14, color: '#6b7280' },
  totalValue: { fontSize: 18, fontWeight: '800', color: '#111827' },

  onlineHint: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: '#eff6ff',
    borderRadius: 14,
    padding: 14,
    alignItems: 'flex-start',
  },
  onlineHintIcon: { fontSize: 18 },
  onlineHintText: { flex: 1, fontSize: 13, color: '#1d4ed8', lineHeight: 20 },
});

function getAccessToken(): string {
  return ''; // TODO: from auth context
}
