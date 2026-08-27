/**
 * Client/server version mismatch check.
 *
 * The client ships with a synced copy of version.json. If the deployed server
 * reports something different, the two halves were not deployed together —
 * a real and easily-missed class of deploy bug.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import localVersion from "../version.json";

export function useVersionCheck() {
  const [mismatch, setMismatch] = useState(/** @type {null | { client: string, server: string }} */ (null));

  useEffect(() => {
    let cancelled = false;

    api
      .version()
      .then((serverVersion) => {
        if (cancelled || !serverVersion?.version) return;
        if (serverVersion.version !== localVersion.version) {
          console.warn(
            `client/server version mismatch — did you forget to redeploy? ` +
              `client=${localVersion.version} server=${serverVersion.version}`,
          );
          setMismatch({ client: localVersion.version, server: serverVersion.version });
        }
      })
      .catch(() => {
        // A sleeping backend is not a version problem; stay quiet.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { local: localVersion, mismatch };
}
