import fs from 'fs';
function sub(p,a,b){let s=fs.readFileSync(p,'utf8');if(s.includes('
')){a=a.replace(/
/g,'
');b=b.replace(/
/g,'
');}if(!s.includes(a))throw new Error(p+a);fs.writeFileSync(p,s.replace(a,()=>b));}
sub('src/components/search/SearchPage.tsx',`  onSessionChange?: Dispatch<SetStateAction<SearchSessionState>>;
}`,`  onSessionChange?: Dispatch<SetStateAction<SearchSessionState>>;
  /** The automatic company list download (#637): shown as one short line only after it failed. */
  companyList?: { failed: boolean; retrying: boolean; retry: () => void };
}`);
sub('src/components/search/SearchPage.tsx',`  onSessionChange,
}: SearchPageProps = {}) {`,`  onSessionChange,
  companyList,
}: SearchPageProps = {}) {`);
sub('src/components/search/SearchPage.tsx',`        {cacheNotice && (`,`        {companyList?.failed && (
          <div className="alert alert-info alert-soft mt-3 flex items-center justify-between gap-3 text-sm" role="status">
            <span>Could not download the company list. Searches still use the other sources.</span>
            <button type="button" className="btn btn-ghost btn-xs" onClick={companyList.retry}>
              Try again
            </button>
          </div>
        )}
        {cacheNotice && (`);
sub('src/App.tsx',`import { WelcomeModal }`,`import { useAutoCompanyList } from './components/settings/useAutoCompanyList.js';
import { WelcomeModal }`);
sub('src/App.tsx',`  const [nav, setNav] = useState<NavPage>('search');`,`  const companyList = useAutoCompanyList();
  const [nav, setNav] = useState<NavPage>('search');`);
sub('src/App.tsx',`              onSessionChange={setSearchSession}
            />`,`              onSessionChange={setSearchSession}
              companyList={companyList}
            />`);
sub('src/components/settings/SettingsPage.tsx',`          <AtsRosterSection
            disabled={disabled}`,`          <AtsRosterSection
            disabled={disabled}
            autoDownload={settings.autoRosterDownloadEnabled}
            onAutoDownloadChange={(autoRosterDownloadEnabled) => changeField({ autoRosterDownloadEnabled })}`);
sub('src/components/settings/AtsRosterSection.tsx',`import { SettingsRow, SettingsSection } from`,`import { SettingsRow, SettingsSection, ToggleSwitch } from`);
sub('src/components/settings/AtsRosterSection.tsx',`  disabled?: boolean;
`,`  disabled?: boolean;
  /** The saved \`autoRosterDownloadEnabled\` setting (#637). */
  autoDownload: boolean;
  onAutoDownloadChange: (enabled: boolean) => void;
`);
sub('src/components/settings/AtsRosterSection.tsx',`({ disabled, onRefreshed,`,`({ disabled, autoDownload, onAutoDownloadChange, onRefreshed,`);
sub('src/components/settings/AtsRosterSection.tsx',`    <SettingsSection title="Company list">
`,`    <SettingsSection title="Company list">
      <SettingsRow
        label="Download the company list automatically"
        description="Downloads it when the app first opens and no list is saved yet."
      >
        <ToggleSwitch
          label="Download the company list automatically"
          checked={autoDownload}
          disabled={disabled}
          onChange={onAutoDownloadChange}
        />
      </SettingsRow>
`);
