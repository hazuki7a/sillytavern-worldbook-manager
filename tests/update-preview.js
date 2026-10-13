import { mountUpdateChecker } from '/update-check.js';
mountUpdateChecker(document.getElementById('panel'), {
    moduleUrl: 'http://localhost/scripts/extensions/third-party/sillytavern-worldbook-manager/update-check.js',
    types: { 'third-party/sillytavern-worldbook-manager': 'local' }, headers: () => ({}),
    fetcher: async () => {
        const state = document.getElementById('scenario').value;
        return state === 'error' ? { ok: false, status: 500 } : { ok: true, json: async () => ({
            currentCommitHash: state === 'manual' ? '' : 'example-hash', remoteUrl: state === 'manual' ? '' : 'https://github.com/hazuki7a/sillytavern-worldbook-manager',
            currentBranchName: 'main', isUpToDate: state !== 'available',
        }) };
    },
});
