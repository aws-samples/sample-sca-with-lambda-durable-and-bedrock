import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { AppSyncEvent } from '../types';

interface RealTimeContextType {
  isConnected: boolean;
  error: string | null;
  subscribe: (contactId: string, callback: (event: AppSyncEvent) => void) => () => void;
  subscribeToAll: (callback: (event: AppSyncEvent) => void) => () => void;
}

const RealTimeContext = createContext<RealTimeContextType | undefined>(undefined);

export const RealTimeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isConnected] = useState(true); // Always "connected" for polling
  const [error] = useState<string | null>(null);

  // Polling-based approach - no WebSocket connection needed
  // The frontend will poll the API for updates instead of receiving real-time events
  // This is a simpler approach that works without AppSync Events VPC endpoint support

  const subscribe = useCallback((_contactId: string, _callback: (event: AppSyncEvent) => void) => {
    // No-op for now - polling will be handled by individual components
    // Return unsubscribe function
    return () => {
      // No-op
    };
  }, []);

  const subscribeToAll = useCallback((callback: (event: AppSyncEvent) => void) => {
    return subscribe('*', callback);
  }, [subscribe]);

  return (
    <RealTimeContext.Provider value={{ isConnected, error, subscribe, subscribeToAll }}>
      {children}
    </RealTimeContext.Provider>
  );
};

export const useRealTime = () => {
  const context = useContext(RealTimeContext);
  if (context === undefined) {
    throw new Error('useRealTime must be used within a RealTimeProvider');
  }
  return context;
};
