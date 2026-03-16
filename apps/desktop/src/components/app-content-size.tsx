import { createContext, useContext, useRef, type RefObject } from "react";
import { useResizeObserver } from "usehooks-ts";

const AppContentSizeContext = createContext<{ width: number; height: number; ready: boolean }>({
  width: 0,
  height: 0,
  ready: false,
});

export const useContentSize = () => {
  return useContext(AppContentSizeContext);
};

export const AppContentSizeProvider = ({
  children,
  ...props
}: { children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) => {
  const parentRef = useRef<HTMLDivElement | null>(null);

  const s = useResizeObserver({
    ref: parentRef as RefObject<HTMLDivElement>,
    box: "border-box",
  });

  return (
    <div ref={parentRef} {...props}>
      <AppContentSizeContext.Provider
        value={
          s.width && s.height
            ? {
                ready: true,
                width: s.width,
                height: s.height,
              }
            : { ready: false, width: 0, height: 0 }
        }
      >
        {children}
      </AppContentSizeContext.Provider>
    </div>
  );
};
