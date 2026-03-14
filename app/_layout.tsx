import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, useNavigationContainerRef } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState, useRef } from "react";
import { StatusBar, View, Text, StyleSheet, Platform, AppState, AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { BiometricGate } from "@/src/security/BiometricGate";
import UltraDevLog from "@/src/utils/UltraDevLog";

SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#000000" },
        animation: "slide_from_right",
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen
        name="settings"
        options={{
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const navigationRef = useNavigationContainerRef();
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const biometricAvailableRef = useRef(false);

  useEffect(() => {
    if (!navigationRef.current) return;
    const unsub = navigationRef.current.addListener('state', () => {
      const state = navigationRef.current?.getRootState();
      if (!state) return;
      const route = state.routes[state.index ?? 0];
      UltraDevLog.navChange(route?.name ?? 'unknown', 'navigate', state.routes.length, route?.params as Record<string, unknown>);
    });
    return unsub;
  }, [navigationRef.current]);

  useEffect(() => {
    async function checkAuth() {
      try {
        const gate = new BiometricGate();
        const available = await gate.isAvailable();
        biometricAvailableRef.current = available;
        if (available) {
          const result = await gate.authenticate("Authenticate to open Agent Ultra");
          setAuthenticated(result);
        } else {
          setAuthenticated(true);
        }
      } catch {
        setAuthenticated(true);
      }
      setAuthChecked(true);
    }

    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
      checkAuth();
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (
        appStateRef.current !== "active" &&
        nextState === "active" &&
        biometricAvailableRef.current
      ) {
        setAuthenticated(false);
        setAuthChecked(false);
        const gate = new BiometricGate();
        gate.authenticate("Authenticate to unlock Agent Ultra").then((r) => {
          setAuthenticated(r);
          setAuthChecked(true);
        }).catch(() => {
          setAuthenticated(false);
          setAuthChecked(true);
        });
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, []);

  if (!fontsLoaded && !fontError) return null;

  const textFont = fontsLoaded ? "Inter_600SemiBold" : undefined;
  const retryFont = fontsLoaded ? "Inter_400Regular" : undefined;

  if (!authChecked) {
    return (
      <SafeAreaProvider>
        <View style={lockStyles.container}>
          <StatusBar barStyle="light-content" backgroundColor="#000000" />
          <Text style={[lockStyles.text, { fontFamily: textFont }]}>Authenticating...</Text>
        </View>
      </SafeAreaProvider>
    );
  }

  if (!authenticated) {
    return (
      <SafeAreaProvider>
        <View style={lockStyles.container}>
          <StatusBar barStyle="light-content" backgroundColor="#000000" />
          <Text style={[lockStyles.text, { fontFamily: textFont }]}>Authentication required</Text>
          <Text
            style={[lockStyles.retry, { fontFamily: retryFont }]}
            onPress={() => {
              setAuthChecked(false);
              const gate = new BiometricGate();
              gate.authenticate("Authenticate to open Agent Ultra").then((r) => {
                setAuthenticated(r);
                setAuthChecked(true);
              });
            }}
          >
            Tap to retry
          </Text>
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <StatusBar barStyle="light-content" backgroundColor="#000000" />
              <RootLayoutNav />
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const lockStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
    justifyContent: "center",
    alignItems: "center",
    paddingTop: Platform.OS === "web" ? 67 : 0,
  },
  text: {
    color: "#34d399",
    fontSize: 18,
  },
  retry: {
    color: "#34d399",
    fontSize: 16,
    marginTop: 20,
    textDecorationLine: "underline",
  },
});
