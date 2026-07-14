// Noriq brand mark — a 128² downscale of the full logo (noriq.png), rendered at
// whatever size the slot needs. The 1024² original stays available for hi-res use.
export function Logo({ size = 32, radius }: { size?: number; radius?: number }) {
  return (
    <img
      src="/noriq-mark.png"
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
