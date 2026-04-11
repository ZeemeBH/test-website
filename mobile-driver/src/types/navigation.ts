export type DriverStackParamList = {
  Dashboard: undefined;
  DispatchOffer: { offer: {
    orderId: string;
    orderNumber: string;
    pickupAddress: { line1: string; city: string };
    dropoffAddress: { line1: string; city: string };
    distanceKm: number;
    estimatedFare: number;
    currency: string;
    timeoutSec: number;
  }};
  ActiveJob: { orderId: string };
  Profile: undefined;
};
