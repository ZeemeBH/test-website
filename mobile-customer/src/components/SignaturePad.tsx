/**
 * @file SignaturePad.tsx
 * Digital signature capture for proof-of-delivery.
 *
 * Renders a canvas-like touch surface using React Native's PanResponder.
 * The drawn path is captured as a series of SVG path segments and exported
 * as a base64-encoded PNG via react-native-svg + react-native-view-shot.
 *
 * ── Integration ───────────────────────────────────────────────────────────
 * Mount this component when the driver marks the order as DELIVERED.
 * On confirm, the base64 PNG is sent to POST /orders/:id/delivered as
 * `proofOfDelivery.signatureBase64`.
 *
 * ── Libraries ─────────────────────────────────────────────────────────────
 * - react-native-svg: renders the path segments during drawing
 * - react-native-view-shot: captures the View as a PNG
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   <SignaturePad
 *     onConfirm={(base64) => submitProof(base64)}
 *     onClear={() => {}}
 *   />
 */

import React, { useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  PanResponder,
  StyleSheet,
  Dimensions,
  Alert,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import ViewShot, { captureRef } from 'react-native-view-shot';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Point { x: number; y: number }
interface Stroke { points: Point[] }

interface SignaturePadProps {
  /** Called with base64 PNG when user confirms */
  onConfirm: (base64: string) => void;
  /** Called when user taps Clear */
  onClear?: () => void;
  /** Recipient's name (displayed in prompt) */
  recipientName?: string;
}

const PAD_WIDTH = Dimensions.get('window').width - 48;
const PAD_HEIGHT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// SVG path builder
// ─────────────────────────────────────────────────────────────────────────────

function strokeToSvgPath(stroke: Stroke): string {
  if (stroke.points.length === 0) return '';
  const [first, ...rest] = stroke.points;
  let d = `M ${first.x} ${first.y}`;
  rest.forEach((p) => { d += ` L ${p.x} ${p.y}`; });
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function SignaturePad({ onConfirm, onClear, recipientName }: SignaturePadProps) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);
  const [capturing, setCapturing] = useState(false);
  const viewShotRef = useRef<ViewShot>(null);
  const padOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const isEmpty = strokes.length === 0 && !currentStroke;

  // ── Pan responder ─────────────────────────────────────────────────────────

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,

      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        setCurrentStroke({ points: [{ x: locationX, y: locationY }] });
      },

      onPanResponderMove: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        setCurrentStroke((prev) =>
          prev ? { points: [...prev.points, { x: locationX, y: locationY }] } : null,
        );
      },

      onPanResponderRelease: () => {
        setCurrentStroke((prev) => {
          if (prev && prev.points.length > 0) {
            setStrokes((s) => [...s, prev]);
          }
          return null;
        });
      },
    }),
  ).current;

  // ── Clear ─────────────────────────────────────────────────────────────────

  const handleClear = useCallback(() => {
    setStrokes([]);
    setCurrentStroke(null);
    onClear?.();
  }, [onClear]);

  // ── Confirm (capture PNG) ─────────────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    if (isEmpty) {
      Alert.alert('Signature required', 'Please sign before confirming.');
      return;
    }

    setCapturing(true);
    try {
      // captureRef renders the ViewShot node as a PNG and returns a file URI
      const uri = await captureRef(viewShotRef, {
        format: 'png',
        quality: 0.8,
        result: 'base64',
      });

      onConfirm(uri);
    } catch {
      Alert.alert('Capture failed', 'Could not capture signature. Please try again.');
    } finally {
      setCapturing(false);
    }
  }, [isEmpty, onConfirm]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        {recipientName ? `${recipientName}'s Signature` : 'Customer Signature'}
      </Text>
      <Text style={styles.subtitle}>
        Please hand the device to the recipient to sign below
      </Text>

      {/* ── Signature canvas ─────────────────────────────────────────── */}
      <ViewShot ref={viewShotRef} options={{ format: 'png', quality: 0.8 }}>
        <View
          style={styles.pad}
          {...panResponder.panHandlers}
          onLayout={(e) => {
            padOffsetRef.current = {
              x: e.nativeEvent.layout.x,
              y: e.nativeEvent.layout.y,
            };
          }}
        >
          {/* Background guide line */}
          <View style={styles.guideLine} />

          <Svg width={PAD_WIDTH} height={PAD_HEIGHT} style={StyleSheet.absoluteFillObject}>
            {/* Completed strokes */}
            {strokes.map((stroke, i) => (
              <Path
                key={i}
                d={strokeToSvgPath(stroke)}
                stroke="#1e293b"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            ))}
            {/* Current stroke (live preview) */}
            {currentStroke && (
              <Path
                d={strokeToSvgPath(currentStroke)}
                stroke="#1e293b"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            )}
          </Svg>

          {isEmpty && (
            <Text style={styles.placeholder}>Sign here</Text>
          )}
        </View>
      </ViewShot>

      {/* ── Actions ──────────────────────────────────────────────────── */}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
          <Text style={styles.clearBtnText}>Clear</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.confirmBtn, (isEmpty || capturing) && styles.confirmBtnDisabled]}
          onPress={handleConfirm}
          disabled={isEmpty || capturing}
        >
          <Text style={styles.confirmBtnText}>
            {capturing ? 'Saving…' : 'Confirm Signature'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { padding: 16 },
  title: { fontSize: 17, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#6b7280', marginBottom: 16 },

  pad: {
    width: PAD_WIDTH,
    height: PAD_HEIGHT,
    borderWidth: 1.5,
    borderColor: '#d1d5db',
    borderRadius: 12,
    backgroundColor: '#fff',
    overflow: 'hidden',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  guideLine: {
    position: 'absolute',
    bottom: 32,
    left: 20,
    right: 20,
    height: 1,
    backgroundColor: '#e5e7eb',
  },
  placeholder: {
    position: 'absolute',
    bottom: 44,
    color: '#d1d5db',
    fontSize: 18,
    fontStyle: 'italic',
  },

  actions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  clearBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    alignItems: 'center',
  },
  clearBtnText: { fontSize: 15, fontWeight: '600', color: '#6b7280' },
  confirmBtn: {
    flex: 2,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    shadowColor: '#2563eb',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  confirmBtnDisabled: { backgroundColor: '#93c5fd', shadowOpacity: 0 },
  confirmBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
});
