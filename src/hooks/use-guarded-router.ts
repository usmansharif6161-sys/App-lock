import { useRef } from 'react';
import { useRouter } from 'expo-router';

/**
 * Custom router hook that prevents rapid multi-taps from pushing duplicate screens.
 */
export function useGuardedRouter() {
  const router = useRouter();
  const lastPressTime = useRef(0);

  const isRapidPress = (thresholdMs = 500) => {
    const now = Date.now();
    if (now - lastPressTime.current < thresholdMs) {
      return true;
    }
    lastPressTime.current = now;
    return false;
  };

  return {
    ...router,
    push: (href: any, options?: any) => {
      if (isRapidPress()) return;
      router.push(href, options);
    },
    replace: (href: any, options?: any) => {
      if (isRapidPress()) return;
      router.replace(href, options);
    },
    navigate: (href: any, options?: any) => {
      if (isRapidPress()) return;
      router.navigate(href, options);
    },
  };
}
