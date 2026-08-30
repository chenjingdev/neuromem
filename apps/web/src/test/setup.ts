import "@testing-library/jest-dom/vitest";

Object.assign(navigator, {
  clipboard: { writeText: async () => undefined },
});
