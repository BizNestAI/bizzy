import { useContext } from 'react';
import { BusinessContext } from '../context/BusinessContext';

export default function useCurrentBusiness() {
  const { currentBusiness } = useContext(BusinessContext);

  if (!currentBusiness) {
    console.warn('⚠️ useCurrentBusiness: No business is currently selected.');
  }

  return { currentBusiness };
}
