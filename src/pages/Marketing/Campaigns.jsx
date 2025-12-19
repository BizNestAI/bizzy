// src/pages/Marketing/Campaigns.jsx
import React from 'react';
import EmailCampaignBuilder from '../../components/Marketing/EmailCampaignBuilder';
import EmailCampaignGallery from '../../components/Marketing/EmailCampaignGallery';
import { useBusiness } from '../../context/BusinessContext';

export default function Campaigns() {
  const { currentBusiness } = useBusiness();
  const businessId = currentBusiness?.id || localStorage.getItem('currentBusinessId');

  return (
    <div className="min-h-screen w-full px-4 py-6 text-white">
      <EmailCampaignBuilder businessId={businessId} />
      <div className="mt-10"><EmailCampaignGallery businessId={businessId} /></div>
    </div>
  );
}
