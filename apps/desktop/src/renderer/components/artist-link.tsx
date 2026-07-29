import { Link } from "@tanstack/react-router";

export function ArtistLink({
  artistId,
  children,
  className,
}: {
  artistId: string | null | undefined;
  children: React.ReactNode;
  className?: string;
}) {
  if (!artistId) {
    return <span className={className}>{children}</span>;
  }

  return (
    <Link
      to="/app/artists/$artistId"
      params={{ artistId }}
      className={className}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
    >
      {children}
    </Link>
  );
}
