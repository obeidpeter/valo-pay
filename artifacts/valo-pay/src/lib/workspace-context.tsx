import { createContext, useContext, ReactNode, useState, useEffect, useRef } from 'react';
import { useGetWorkspace, Workspace } from '@workspace/api-client-react';
import { useSessionUser } from '@/lib/auth';
import { useQueryClient } from '@tanstack/react-query';

type WorkspaceContextType = {
  merchantId: string | null;
  setMerchantId: (id: string) => void;
  workspace: Workspace | undefined;
  isLoading: boolean;
};

const WorkspaceContext = createContext<WorkspaceContextType | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const {userId,isLoaded:authLoaded}=useSessionUser();
  // Never hold the anonymous sandbox hostage to a slow or unreachable sign-in service.
  const [authTimedOut,setAuthTimedOut]=useState(false);
  useEffect(()=>{if(authLoaded)return;const timer=setTimeout(()=>setAuthTimedOut(true),5000);return()=>clearTimeout(timer);},[authLoaded]);
  const isLoaded=authLoaded||authTimedOut;
  const queryClient=useQueryClient();
  const previousUser=useRef<string|null|undefined>(undefined);
  const { data: workspace, isLoading,error,refetch } = useGetWorkspace({query:{queryKey:["workspace",userId||"sandbox"],enabled:isLoaded,refetchInterval:30000}});
  const [selectedMerchant, setMerchantId] = useState<string | null>(null);
  const merchantId=workspace?.merchants.some(m=>m.id===selectedMerchant)?selectedMerchant:workspace?.merchants[0]?.id||null;

  useEffect(() => {
    if(!isLoaded)return;
    if(previousUser.current!==undefined&&previousUser.current!==(userId||null)){queryClient.clear();setMerchantId(null);}
    previousUser.current=userId||null;
  },[userId,isLoaded,queryClient]);

  return (
    <WorkspaceContext.Provider value={{ merchantId, setMerchantId, workspace, isLoading:isLoading||!isLoaded }}>
      {error?<div className="min-h-screen grid place-items-center p-6"><div role="alert" className="space-y-3 text-center"><h1 className="font-semibold text-xl">Could not load your workspace</h1><p>No lender data has been changed.</p><button className="rounded bg-primary text-primary-foreground px-4 py-2" onClick={()=>refetch()}>Try again</button></div></div>:children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}
