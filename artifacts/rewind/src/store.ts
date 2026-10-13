import { create } from 'zustand'

/** Access key lives in memory for the tab only. */
interface AuthState { key: string | null; setKey: (k: string | null) => void }
export const useAuth = create<AuthState>((set) => ({ key: null, setKey: (key) => set({ key }) }))

/** Which branch and step the user is looking at, plus diff-mode selection. */
interface SelectionState {
  branchId: string | null
  stepIndex: number | null       // null = follow the latest step
  diffMode: boolean
  diffOther: string | null       // second branch when in diff mode
  diffOtherStep: number | null
  contextOpen: boolean
  forkOpen: boolean
  compareParent: string | null   // parent branch whose forks are being compared
  selectBranch: (id: string) => void
  setStep: (i: number | null) => void
  toggleDiffWith: (id: string) => void
  setDiffMode: (on: boolean) => void
  setDiffOtherStep: (i: number | null) => void
  setContextOpen: (open: boolean) => void
  setForkOpen: (open: boolean) => void
  setCompareParent: (id: string | null) => void
  resetForSession: () => void
}
export const useSelection = create<SelectionState>((set, get) => ({
  branchId: null,
  stepIndex: null,
  diffMode: false,
  diffOther: null,
  diffOtherStep: null,
  contextOpen: false,
  forkOpen: false,
  compareParent: null,
  selectBranch: (id) => set({ branchId: id, stepIndex: null, forkOpen: false, compareParent: null }),
  setCompareParent: (compareParent) => set({ compareParent, diffMode: false, diffOther: null }),
  resetForSession: () => set({ branchId: null, stepIndex: null, diffMode: false, diffOther: null, diffOtherStep: null, contextOpen: false, forkOpen: false, compareParent: null }),
  setStep: (stepIndex) => set({ stepIndex }),
  toggleDiffWith: (id) => {
    const { branchId, diffOther } = get()
    if (id === branchId) return
    if (diffOther === id) set({ diffMode: false, diffOther: null, diffOtherStep: null })
    else set({ diffMode: true, diffOther: id, diffOtherStep: null })
  },
  setDiffMode: (on) => set(on ? { diffMode: true } : { diffMode: false, diffOther: null, diffOtherStep: null }),
  setDiffOtherStep: (diffOtherStep) => set({ diffOtherStep }),
  setContextOpen: (contextOpen) => set({ contextOpen }),
  setForkOpen: (forkOpen) => set({ forkOpen }),
}))
