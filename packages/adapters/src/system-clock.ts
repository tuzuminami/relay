import type { Clock } from "../../core/src/ports.ts";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
