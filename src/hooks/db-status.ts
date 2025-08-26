import { useEffect, useRef, useState } from "react";

interface DatabaseStatus {
  status?: string;
  isConnected: boolean;
  timestamp: string;
}

// Function to fetch database status from API
const fetchDatabaseStatus = async (): Promise<DatabaseStatus | null> => {
  try {
    const response = await fetch('/api/db/status');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (error: unknown) {
    console.error("Error fetching database status:", (error as Error).message);
    return null;
  }
};

// Idle timeout
const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 180000

// Hook for continuous database monitoring with idle pause/resume
export const useDatabaseStatus = (
  intervalMs: number = 40000 // Poll every 40 seconds
) => {
  const [status, setStatus] = useState<string | undefined>();
  const [isConnected, setIsConnected] = useState<boolean>(false);

  // Mutable refs to avoid re-renders and preserve values across effect executions
  const isSubscribedRef = useRef(true);
  const desiredDelayRef = useRef(intervalMs);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Idle detection and pause/resume state
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPausedRef = useRef<boolean>(false);
  const activityHandlersRef = useRef<{ type: string; handler: (e?: Event) => void }[]>([]);

  // Keep desiredDelayRef in sync with the latest prop value on re-renders
  useEffect(() => {
    desiredDelayRef.current = intervalMs;
  }, [intervalMs]);

  useEffect(() => {
    isSubscribedRef.current = true;

    const logPrefix = "[db-status]";
    let cycle = 0;

    const scheduleNext = (delayMs: number) => {
      if (!isSubscribedRef.current || isPausedRef.current) return;
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
      console.log(`${logPrefix} scheduling next check in ${delayMs}ms (cycle=${cycle})`);
      timeoutIdRef.current = setTimeout(checkStatus, delayMs);
    };

    const checkStatus = async () => {
      if (!isSubscribedRef.current || isPausedRef.current) return;

      cycle += 1;
      console.log(
        new Date().toISOString(),
        `${logPrefix} cycle=${cycle} Starting status check...`
      );

      const data = await fetchDatabaseStatus();

      if (isSubscribedRef.current && !isPausedRef.current && data) {
        setStatus(data.status);
        setIsConnected(data.isConnected);

        // Adjust desired delay dynamically based on connectivity
        const previous = desiredDelayRef.current;
        if (data.isConnected) {
          desiredDelayRef.current = 120000; // 120s when connected
        } else {
          desiredDelayRef.current = Math.min(previous, intervalMs); // fall back to initial/default if we previously increased
        }

        if (previous !== desiredDelayRef.current) {
          console.log(
            `${logPrefix} delay change: ${previous}ms -> ${desiredDelayRef.current}ms`
          );
        }

        console.log(
          `${logPrefix} Overall Status - Management: ${data.status ?? "Unknown"}, Connection: ${
            data.isConnected ? "Active" : "Inactive"
          }`
        );

        if (data.status === "Online" && data.isConnected) {
          console.log(`${logPrefix} Database is fully operational and responsive.`);
        } else {
          console.warn(`${logPrefix} Database may be unresponsive or in an unexpected state.`);
        }
      }

      // Schedule next run using the latest desired delay
      if (isSubscribedRef.current && !isPausedRef.current) {
        const nextDelay = desiredDelayRef.current;
        scheduleNext(nextDelay);
      }
    };

    const stopMonitoring = (reason: string) => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
      console.log(`${logPrefix} monitoring paused: ${reason}`);
    };

    const startMonitoring = async (immediate: boolean) => {
      if (!isSubscribedRef.current) return;
      if (isPausedRef.current) return; // should be set to false by caller before this
      // Kick off the self-scheduling loop
      const firstDelay = desiredDelayRef.current;
      if (immediate) {
        // Run an immediate check then schedule next
        await checkStatus();
        if (isSubscribedRef.current && !isPausedRef.current) {
          scheduleNext(desiredDelayRef.current);
        }
      } else {
        console.log(`[db-status] starting monitoring loop with delay=${firstDelay}ms`);
        scheduleNext(firstDelay);
      }
    };

    const onIdle = () => {
      if (!isSubscribedRef.current) return;
      if (isPausedRef.current) return;
      isPausedRef.current = true;

      // Stop future checks and set status to Unknown
      stopMonitoring("page idle");
      setStatus("Unknown");
      setIsConnected(false);
      console.warn(`${logPrefix} Page idle detected. Monitoring stopped and status set to Unknown.`);
    };

    const resetIdleTimer = () => {
      if (!isSubscribedRef.current) return;
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      idleTimerRef.current = setTimeout(onIdle, IDLE_TIMEOUT_MS);
    };

    const onActivity = () => {
      if (!isSubscribedRef.current) return;

      // Any activity resets the idle timer
      resetIdleTimer();

      // If paused due to idle, auto-resume
      if (isPausedRef.current) {
        console.log(`${logPrefix} Activity detected after idle. Auto-resuming monitoring...`);
        isPausedRef.current = false;
        // fetch immediately on resume to refresh UI fast
        startMonitoring(true);
      }
    };

    // Register user activity listeners
    const addHandler = (type: string, handler: (e?: Event) => void) => {
      window.addEventListener(type, handler as EventListener, { passive: true });
      activityHandlersRef.current.push({ type, handler });
    };

    addHandler("keydown", onActivity);
    addHandler("wheel", onActivity);
    addHandler("touchstart", onActivity);
    addHandler("scroll", onActivity);
    // visibilitychange: treat "visible" as activity
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        onActivity();
      }
    };
    addHandler("visibilitychange", onVisibilityChange);

    // Initial check (immediate), then schedule loop
    const monitor = async () => {
      try {
        // Reset idle timer at mount
        resetIdleTimer();

        // Initial check (immediate)
        const initialData = await fetchDatabaseStatus();
        if (isSubscribedRef.current && !isPausedRef.current && initialData) {
          setStatus(initialData.status);
          setIsConnected(initialData.isConnected);
          console.log("[db-status] Initial database status check completed.");

          // Potentially adjust delay right after initial response
          if (initialData.isConnected) {
            const prev = desiredDelayRef.current;
            desiredDelayRef.current = 60000;
            if (prev !== desiredDelayRef.current) {
              console.log(
                `[db-status] delay change after initial: ${prev}ms -> ${desiredDelayRef.current}ms`
              );
            }
          }
        }

        // Kick off the self-scheduling loop
        if (!isPausedRef.current) {
          const firstDelay = desiredDelayRef.current;
          console.log(`[db-status] starting monitoring loop with delay=${firstDelay}ms`);
          scheduleNext(firstDelay);
        }
      } catch (error: unknown) {
        console.error(
          "[db-status] Critical error in monitoring loop:",
          (error as Error).message
        );
      }
    };

    monitor();

    // Cleanup
    return () => {
      isSubscribedRef.current = false;

      // Clear polling timeout
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }

      // Clear idle timer
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }

      // Remove listeners
      for (const { type, handler } of activityHandlersRef.current) {
        window.removeEventListener(type, handler as EventListener);
      }
      activityHandlersRef.current = [];

      console.log("[db-status] monitoring loop cleaned up");
    };
  }, [intervalMs]); // depend on the initial/default prop so external changes reset the loop

  return { status, isConnected };
};
