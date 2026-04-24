"use client";

import { useEffect } from "react";

export function RegisterSW() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker
        .register("/sw.js")
        .catch(() => {
          // swallow — SW registration failure shouldn't break the app
        });
    }
  }, []);
  return null;
}
