import { Button, Result } from 'antd';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';

import { describeError } from '@/api/http';

export function RouteErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : describeError(error).message;

  return (
    <Result
      status="error"
      title="路由出错"
      subTitle={message}
      extra={
        <Button type="primary" onClick={() => navigate('/dashboard')}>
          回到仪表盘
        </Button>
      }
    />
  );
}
