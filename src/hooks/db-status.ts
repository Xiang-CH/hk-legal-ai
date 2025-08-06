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

// Hook for continuous database monitoring
export const useDatabaseStatus = (
  intervalMs: number = 20000 // Poll every 20 seconds
) => {
  const [status, setStatus] = useState<string | undefined>();
  const [isConnected, setIsConnected] = useState<boolean>(false);

  // Mutable refs to avoid re-renders and preserve values across effect executions
  const isSubscribedRef = useRef(true);
  const desiredDelayRef = useRef(intervalMs);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep desiredDelayRef in sync with the latest prop value on re-renders
  useEffect(() => {
    desiredDelayRef.current = intervalMs;
  }, [intervalMs]);

  useEffect(() => {
    isSubscribedRef.current = true;

    const logPrefix = "[db-status]";
    let cycle = 0;

    const checkStatus = async () => {
      if (!isSubscribedRef.current) return;

      cycle += 1;
      console.log(
        new Date().toISOString(),
        `${logPrefix} cycle=${cycle} Starting status check...`
      );

      const data = await fetchDatabaseStatus();

      if (isSubscribedRef.current && data) {
        setStatus(data.status);
        setIsConnected(data.isConnected);

        // Adjust desired delay dynamically based on connectivity
        const previous = desiredDelayRef.current;
        if (data.isConnected) {
          desiredDelayRef.current = 60000; // 60s when connected
        } else {
          desiredDelayRef.current = Math.min(previous, intervalMs); // fall back to initial/default if we previously increased
        }

        if (previous !== desiredDelayRef.current) {
          console.log(
            `${logPrefix} delay change: ${previous}ms -> ${desiredDelayRef.current}ms`
          );
        }

        console.log(
          `${logPrefix} Overall Status - Management: ${data.status ?? "Unknown"}, Connection: ${data.isConnected ? "Active" : "Inactive"}`
        );

        if (data.status === "Online" && data.isConnected) {
          console.log(`${logPrefix} Database is fully operational and responsive.`);
        } else {
          console.warn(`${logPrefix} Database may be unresponsive or in an unexpected state.`);
        }
      }

      // Schedule next run using the latest desired delay
      if (isSubscribedRef.current) {
        const nextDelay = desiredDelayRef.current;
        console.log(
          `${logPrefix} scheduling next check in ${nextDelay}ms (cycle=${cycle})`
        );
        timeoutIdRef.current = setTimeout(checkStatus, nextDelay);
      }
    };

    const monitor = async () => {
      try {
        // Initial check (immediate)
        const initialData = await fetchDatabaseStatus();
        if (isSubscribedRef.current && initialData) {
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
        const firstDelay = desiredDelayRef.current;
        console.log(`[db-status] starting monitoring loop with delay=${firstDelay}ms`);
        timeoutIdRef.current = setTimeout(checkStatus, firstDelay);
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
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
      console.log("[db-status] monitoring loop cleaned up");
    };
  }, [intervalMs]); // depend on the initial/default prop so external changes reset the loop

  return { status, isConnected };
};
