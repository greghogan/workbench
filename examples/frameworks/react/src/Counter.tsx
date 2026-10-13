import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>React counter</h1>
      <output aria-live="polite" aria-label="Count">
        {count}
      </output>
      <button
        type="button"
        onClick={() => {
          setCount((value) => value - 1);
        }}
      >
        Decrease
      </button>
      <button
        type="button"
        onClick={() => {
          setCount((value) => value + 1);
        }}
      >
        Increase
      </button>
      <button
        type="button"
        onClick={() => {
          setCount(0);
        }}
      >
        Reset
      </button>
    </main>
  );
}
