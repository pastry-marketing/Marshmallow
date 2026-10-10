import { useQuery } from "@tanstack/react-query";
import { fetchExtensionRelease } from "@/lib/extension-release";

export function useExtensionRelease() {
  return useQuery({
    queryKey: ["extension-release"], queryFn: fetchExtensionRelease,
    staleTime: 60_000, refetchInterval: 60_000, refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
