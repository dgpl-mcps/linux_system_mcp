import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env") });

const appConfig = {
  deferLoading: process.env.DEFER_LOADING === "true",
};

export function getDeferLoading(): boolean {
  return appConfig.deferLoading;
}

export function isDeferLoadingEnabled(): boolean {
  return appConfig.deferLoading;
}
