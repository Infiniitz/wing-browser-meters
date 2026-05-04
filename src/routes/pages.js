const { Router } = require('express');
const {
  refreshInterval,
  displayLayout,
  meterLabelColors,
  meterTextColors,
  lowResource,
} = require('../services/config');

const router = Router();

router.get('/', (req, res) => {
  res.render('settings', {
    title: 'Settings – Wing Browser Meters',
    hideHeader: false,
    refreshIntervalMs: refreshInterval.getRefreshIntervalMs(),
    displayLayout: displayLayout.getDisplayLayout(),
    meterLabelColors: meterLabelColors.getMeterLabelColors(),
    meterTextColors: meterTextColors.getMeterTextColors(),
    lowResourceMode: lowResource.getLowResourceMode(),
  });
});

router.get('/horizontal', (req, res) => {
  res.render('horizontal', {
    title: 'Horizontal – Wing Browser Meters',
    hideHeader: true,
    bodyClass: 'page-horizontal',
    displayLayout: displayLayout.getDisplayLayout(),
    meterLabelColors: meterLabelColors.getMeterLabelColors(),
    meterTextColors: meterTextColors.getMeterTextColors(),
    lowResourceMode: lowResource.getLowResourceMode(),
  });
});

router.get('/vertical', (req, res) => {
  res.render('vertical', {
    title: 'Vertical – Wing Browser Meters',
    hideHeader: true,
    bodyClass: 'page-vertical',
    displayLayout: displayLayout.getDisplayLayout(),
    meterLabelColors: meterLabelColors.getMeterLabelColors(),
    meterTextColors: meterTextColors.getMeterTextColors(),
    lowResourceMode: lowResource.getLowResourceMode(),
  });
});

module.exports = router;
