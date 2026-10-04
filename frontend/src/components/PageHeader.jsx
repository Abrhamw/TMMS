import { createContext, useContext } from 'react';

const HeaderSlotContext = createContext(null);

export function HeaderSlotProvider({ slot, children }) {
  return <HeaderSlotContext.Provider value={slot}>{children}</HeaderSlotContext.Provider>;
}

export function useHeaderSlot() {
  return useContext(HeaderSlotContext);
}
