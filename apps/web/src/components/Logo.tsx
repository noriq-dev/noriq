// Noriq brand mark — the 1024² logo, rendered at whatever size the slot needs.
export function Logo({ size = 32, radius }: { size?: number; radius?: number }) {
  return (
    <img
      src="/noriq.png"
      alt="Noriq"
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? Math.round(size * 0.26),
        objectFit: 'cover',
        flex: 'none',
        display: 'block',
      }}
    />
  );
}
