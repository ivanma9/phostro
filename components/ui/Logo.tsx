interface LogoProps {
  size?: number;
}

export function Logo({ size = 22 }: LogoProps) {
  return (
    <span className="logo" style={{ fontSize: size }}>
      pocket
    </span>
  );
}
