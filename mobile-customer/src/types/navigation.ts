export type RootStackParamList = {
  Home: undefined;
  CreateOrder: undefined;
  ActiveOrder: { orderId: string; orderNumber: string };
  OrderComplete: { orderId: string };
};
