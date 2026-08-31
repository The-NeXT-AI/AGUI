import { customAlphabet } from "nanoid";

const nano = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 12);

/** Short, URL-safe, collision-resistant id. */
export const uid = (prefix?: string): string => (prefix ? `${prefix}_${nano()}` : nano());
