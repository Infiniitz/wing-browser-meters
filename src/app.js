const express = require('express');
const path = require('path');
const expressLayouts = require('express-ejs-layouts');
const pageRoutes = require('./routes/pages');
const apiRoutes = require('./routes/api');

const app = express();

app.use(express.json());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use('/', pageRoutes);
app.use('/api', apiRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

module.exports = app;
