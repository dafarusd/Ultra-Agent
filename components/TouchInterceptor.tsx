import React, { useCallback } from 'react';
import { View, GestureResponderEvent } from 'react-native';
import { UltraDevLog } from '@/src/utils/UltraDevLog';

interface Props {
  children: React.ReactNode;
}

export default function TouchInterceptor({ children }: Props) {
  const handleTouch = useCallback((e: GestureResponderEvent) => {
    const { pageX, pageY, timestamp } = e.nativeEvent;
    UltraDevLog.push('TOUCH', {
      x: Math.round(pageX),
      y: Math.round(pageY),
      ts: timestamp || Date.now(),
    });
  }, []);

  return (
    <View
      style={{ flex: 1 }}
      onStartShouldSetResponderCapture={() => false}
      onMoveShouldSetResponderCapture={() => false}
      onTouchStart={handleTouch}
    >
      {children}
    </View>
  );
}
