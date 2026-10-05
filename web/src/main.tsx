import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import './styles/global.css';
import { antdTheme } from './theme/antdTheme';

dayjs.locale('zh-cn');

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root not found in index.html');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
