import { actions } from "common/actions";
import { call, messages } from "common/butlerd";
import { Profile } from "common/butlerd/messages";
import { Dispatch } from "common/types";
import React from "react";
import LoadingCircle from "renderer/basics/LoadingCircle";
import { doAsync } from "renderer/helpers/doAsync";
import watching, { Watcher } from "renderer/hocs/watching";
import { hook } from "renderer/hocs/hook";
import { isEmpty } from "underscore";
import LoginForm from "./LoginForm";
import RememberedProfiles from "./RememberedProfiles/index";

@watching
class LoginScreen extends React.PureComponent<Props, State> {
  constructor(props: LoginScreen["props"], context: any) {
    super(props, context);
    this.state = {
      loading: true,
      showingSaved: true,
      profiles: [],
    };
  }

  componentDidMount() {
    this.refresh();
  }

  subscribe(watcher: Watcher) {
    watcher.on(actions.profilesUpdated, async (store, action) => {
      this.refresh();
    });
    watcher.on(actions.loginFailed, async (store, action) => {
      this.showForm();
    });
  }

  refresh() {
    doAsync(async () => {
      const { profiles } = await call(messages.ProfileList, {});
      this.setState({ loading: false, profiles });

      if (isEmpty(profiles)) {
        this.setState({ showingSaved: false });
      }
    });
  }

  render() {
    const { loading, showingSaved, profiles } = this.state;
    if (loading) {
      return <LoadingCircle progress={-1} wide />;
    }

    if (showingSaved) {
      return (
        <RememberedProfiles profiles={profiles} showForm={this.showForm} />
      );
    } else {
      return <LoginForm showSaved={this.showSaved} />;
    }
  }

  showForm = () => {
    this.setState({ showingSaved: false });
  };
  showSaved = () => {
    this.setState({ showingSaved: true });
  };
}

interface Props {
  dispatch: Dispatch;
}

interface State {
  loading: boolean;
  showingSaved: boolean;
  profiles: Profile[];
}

export default hook()(LoginScreen);